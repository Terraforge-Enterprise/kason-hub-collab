/**
 * Multi-month statement export (Task D1) — streamed ZIP.
 *
 * SECURITY + CORRECTNESS integration test (real DB; renderer/proof-pack/storage
 * mocked). Proves:
 *   - the ZIP holds one `statement-<YYYY-MM>[-<apt>].pdf` per POST-only statement
 *     in range; a DRAFT month is EXCLUDED (POST-only gate via the real Prisma WHERE);
 *   - `includeProof=1` adds `bills-<YYYY-MM>[-<apt>].pdf` ONLY for months whose
 *     proof pack is non-null;
 *   - the range is bounded (an out-of-range POSTED month is not included);
 *   - a stored `pdfKey` is reused (fetchStorageBuffer) instead of re-rendering;
 *   - the PORTAL mirror is owner-scoped (owner B sees none of owner A's → 404).
 *
 * Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *   DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_test" \
 *   npx vitest run src/modules/owner-billing/__tests__/multi-month-export.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import JSZip from "jszip";

// Keep every real export; override only the collaborators D1 consumes so no
// puppeteer render / Supabase fetch happens (the real Prisma WHERE still runs).
vi.mock("../owner-billing.service", async (orig) => ({
  ...(await orig<typeof import("../owner-billing.service")>()),
  renderCleanStatementPdfBytes: vi.fn(),
}));
vi.mock("../proof-pack.service", async (orig) => ({
  ...(await orig<typeof import("../proof-pack.service")>()),
  buildProofPackPdf: vi.fn(),
}));
vi.mock("../../../lib/storage", async (orig) => ({
  ...(await orig<typeof import("../../../lib/storage")>()),
  fetchStorageBuffer: vi.fn(),
}));

import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import type { PortalEnv, PortalSessionPayload } from "../../portal/auth/portal.auth.types";
import { portalUserTypeGuard } from "../../portal/portal.middleware";
import { ownerBillingRoutes } from "../owner-billing.routes";
import { portalOwnerStatementsRoutes } from "../../portal/owner-statements/portal.owner-statements.routes";
import { streamMonthRangeZip } from "../multi-month-export.service";
import type { OwnerBillingActorCtx } from "../owner-billing.types";
import { renderCleanStatementPdfBytes } from "../owner-billing.service";
import { buildProofPackPdf } from "../proof-pack.service";
import { fetchStorageBuffer } from "../../../lib/storage";

const RUN = process.env.RUN_INTEGRATION === "1";
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Disjoint fixed UUIDs (prefix 3d6… — unique to this suite).
const ORG = "3d600000-0000-4000-8000-0000000000a1";
const OWNER_A = "3d600000-0000-4000-8000-0000000000a2";
const OWNER_B = "3d600000-0000-4000-8000-0000000000a3";
const APT_A = "3d600000-0000-4000-8000-0000000000c1";
const APT8 = APT_A.slice(0, 8);
const UPLOADER = "3d600000-0000-4000-8000-0000000000ee";
const STORED_KEY = "owner-statements/A/2026-01.pdf";

const JAN = new Date(Date.UTC(2026, 0, 1));
const FEB = new Date(Date.UTC(2026, 1, 1));
const MAR = new Date(Date.UTC(2026, 2, 1));
const APR = new Date(Date.UTC(2026, 3, 1));
const SEP = new Date(Date.UTC(2026, 8, 1));

const PROOF_MONTHS = new Set(["2026-01", "2026-03"]);
const RENDER_PDF = Buffer.from("%PDF-rendered\n");
const STORED_PDF = Buffer.from("%PDF-stored\n");
const BILLS_PDF = new Uint8Array(Buffer.from("%PDF-bills\n"));

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: "u-admin", actorRole: "admin" };
const adminSession: SessionPayload = { userId: "u-admin", orgId: ORG, role: "admin", userType: "operator" };

function ownerSession(partyId: string, orgId = ORG): PortalSessionPayload {
  return { userId: `user-${partyId.slice(0, 8)}`, orgId, role: "viewer", userType: "owner", partyId, iat: 0, absoluteExp: 0 };
}

function makeAdminApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}
function makePortalApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/owner/*", portalUserTypeGuard("owner"));
  app.route("/owner", portalOwnerStatementsRoutes);
  return app;
}

async function collect(params: {
  ownerPartyId: string;
  fromMonth: string;
  toMonth: string;
  includeProof: boolean;
}): Promise<string[]> {
  const chunks: Buffer[] = [];
  const sink = { write: (chunk: Uint8Array) => void chunks.push(Buffer.from(chunk)) };
  await streamMonthRangeZip(ctx, params, sink);
  return zipEntries(Buffer.concat(chunks));
}
async function zipEntries(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files).sort();
}

async function cleanup() {
  const db = getDb();
  await db.ownerExpenseProof.deleteMany({ where: { organizationId: ORG } });
  await db.invoice.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Owner Export Org",
      slug: "owner-export-org-3d6",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  for (const [id, name] of [
    [OWNER_A, "Owner A"],
    [OWNER_B, "Owner B"],
  ] as const) {
    await db.party.create({
      data: { id, organizationId: ORG, displayName: name, partyType: "individual", status: "active" },
    });
  }

  let n = 0;
  async function stmt(period: Date, status: string, pdfKey: string | null) {
    n += 1;
    await db.invoice.create({
      data: {
        id: `3d600000-0000-4000-8000-00000000${String(1000 + n)}`,
        organizationId: ORG,
        invoiceNumber: `OS-3D6-${String(n).padStart(4, "0")}`,
        partyId: OWNER_A,
        ownerPartyId: OWNER_A,
        apartmentId: APT_A,
        invoiceType: "owner_statement",
        status,
        invoiceDate: period,
        periodMonth: period,
        totalAmount: "0.00",
        currency: "MYR",
        ...(pdfKey ? { pdfKey } : {}),
      },
    });
  }
  await stmt(JAN, "sent", STORED_KEY); // POSTED + stored PDF (reuse path)
  await stmt(FEB, "approved", null); // POSTED, render path
  await stmt(MAR, "paid", null); // POSTED, render path
  await stmt(APR, "draft", null); // DRAFT — excluded by POST-only
  await stmt(SEP, "sent", null); // POSTED but OUT OF RANGE for 2026-01..2026-03

  for (const period of [JAN, MAR]) {
    await db.ownerExpenseProof.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER_A,
        statementMonth: period,
        apartmentId: APT_A,
        category: "utilities_tnb",
        storageKey: `owner-statements/A/proofs/${period.toISOString().slice(0, 7)}.png`,
        filename: "bill.png",
        uploadedById: UPLOADER,
      },
    });
  }
}

describe.skipIf(!RUN)("multi-month statement export (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(renderCleanStatementPdfBytes).mockResolvedValue(RENDER_PDF);
    vi.mocked(fetchStorageBuffer).mockImplementation(async (key: string) =>
      key === STORED_KEY ? STORED_PDF : null,
    );
    vi.mocked(buildProofPackPdf).mockImplementation(async (_c, _o, month) =>
      PROOF_MONTHS.has(month) ? BILLS_PDF : null,
    );
  });

  it("one statement entry per POST-only month in range; DRAFT + out-of-range excluded", async () => {
    const entries = await collect({ ownerPartyId: OWNER_A, fromMonth: "2026-01", toMonth: "2026-03", includeProof: false });
    expect(entries).toEqual([
      `statement-2026-01-${APT8}.pdf`,
      `statement-2026-02-${APT8}.pdf`,
      `statement-2026-03-${APT8}.pdf`,
    ]);
  });

  it("includeProof adds bills-*.pdf ONLY for months with a non-null proof pack", async () => {
    const entries = await collect({ ownerPartyId: OWNER_A, fromMonth: "2026-01", toMonth: "2026-03", includeProof: true });
    expect(entries).toEqual([
      `bills-2026-01-${APT8}.pdf`,
      `bills-2026-03-${APT8}.pdf`,
      `statement-2026-01-${APT8}.pdf`,
      `statement-2026-02-${APT8}.pdf`,
      `statement-2026-03-${APT8}.pdf`,
    ]);
  });

  it("bounds the range (a POSTED month outside [from,to] is not included)", async () => {
    const entries = await collect({ ownerPartyId: OWNER_A, fromMonth: "2026-01", toMonth: "2026-02", includeProof: false });
    expect(entries).toEqual([
      `statement-2026-01-${APT8}.pdf`,
      `statement-2026-02-${APT8}.pdf`,
    ]);
  });

  it("reuses a stored pdfKey (fetchStorageBuffer) and skips the re-render for that month", async () => {
    await collect({ ownerPartyId: OWNER_A, fromMonth: "2026-01", toMonth: "2026-03", includeProof: false });
    expect(fetchStorageBuffer).toHaveBeenCalledWith(STORED_KEY);
    // JAN served from storage; only FEB + MAR re-rendered.
    expect(renderCleanStatementPdfBytes).toHaveBeenCalledTimes(2);
  });

  it("portal mirror is owner-scoped: owner A → 200 zip; owner B → 404", async () => {
    const a = await makePortalApp(ownerSession(OWNER_A)).request("/owner/statements/export?fromMonth=2026-01&toMonth=2026-03");
    expect(a.status).toBe(200);
    expect(a.headers.get("Content-Type")).toContain("application/zip");
    const entriesA = await zipEntries(Buffer.from(await a.arrayBuffer()));
    expect(entriesA).toContain(`statement-2026-02-${APT8}.pdf`);

    const b = await makePortalApp(ownerSession(OWNER_B)).request("/owner/statements/export?fromMonth=2026-01&toMonth=2026-03");
    expect(b.status).toBe(404);
  });

  it("admin route streams a valid zip with the in-range statements", async () => {
    const res = await makeAdminApp(adminSession).request(
      `/statements/export?ownerPartyId=${OWNER_A}&fromMonth=2026-01&toMonth=2026-03`,
    );
    expect(res.status).toBe(200);
    const entries = await zipEntries(Buffer.from(await res.arrayBuffer()));
    expect(entries).toEqual([
      `statement-2026-01-${APT8}.pdf`,
      `statement-2026-02-${APT8}.pdf`,
      `statement-2026-03-${APT8}.pdf`,
    ]);
  });
});
