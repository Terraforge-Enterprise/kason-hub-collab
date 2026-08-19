/**
 * Portal owner PROOF routes — owner-scoped + POST-only gated (Task C2).
 *
 * SECURITY-CRITICAL integration test (real DB; storage mocked). The owner portal
 * may read the supporting BILLS / proof pack for a statement ONLY when:
 *   - the statement belongs to the SESSION owner (ownerPartyId === session.partyId), AND
 *   - the statement is POSTED (sent/approved/paid/partial) — never a DRAFT month.
 *
 *   (a) flag OFF → 404 (no shape leak)
 *   (b) owner A + A's POSTED statement → proofs 200 (grouped) + proof-pack 200 (application/pdf)
 *   (c) owner A + A's OWN DRAFT statement → 404 on BOTH (post-only gate; draft has proofs but stays hidden)
 *   (d) owner B + A's POSTED statement → 404 on BOTH (owner-scoping)
 *   (e) unknown statement id → 404 (identical shape — no existence leak)
 *   (f) userType guard blocks a non-owner (agent) → 403
 *   (g) owner C (org 2) + A's statement (org 1) → 404 (cross-org isolation)
 *
 * Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *   DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_test" \
 *   npx vitest run src/modules/portal/owner-statements/__tests__/portal.owner-statements.proofs.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Storage mocked: createSignedDownloadUrl (proof list) + fetchStorageBuffer
// (proof pack) drive the route without a real Supabase bucket. The portal proof
// routes never attach/detach, but the proof SERVICE module imports the mutating
// helpers at top level, so they are stubbed too.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
vi.mock("../../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${encodeURIComponent(key)}?token=t`),
  fetchStorageBuffer: vi.fn(async () => PNG_1x1),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  requireBucket: vi.fn(() => "bucket"),
}));

import { getDb } from "@kason/db";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";
import { portalUserTypeGuard } from "../../portal.middleware";
import { portalOwnerStatementsRoutes } from "../portal.owner-statements.routes";

const RUN = process.env.RUN_INTEGRATION === "1";

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Disjoint fixed UUIDs (prefix 2c5… — unique to this suite).
const ORG = "2c500000-0000-4000-8000-0000000000a1";
const OWNER_A = "2c500000-0000-4000-8000-0000000000a2";
const OWNER_B = "2c500000-0000-4000-8000-0000000000a3";
const APT_A = "2c500000-0000-4000-8000-0000000000c1";
const STMT_A_SENT = "2c500000-0000-4000-8000-0000000000a4"; // POSTED ("sent")
const STMT_A_DRAFT = "2c500000-0000-4000-8000-0000000000a5"; // DRAFT (post-only gate)
const UNKNOWN = "2c500000-0000-4000-8000-0000000000ff";
const UPLOADER = "2c500000-0000-4000-8000-0000000000ee";
// Cross-org test: org 2 with its own owner C.
const ORG2 = "2c500000-0000-4000-8000-0000000000b1";
const OWNER_C = "2c500000-0000-4000-8000-0000000000b2";

const JUNE = new Date(Date.UTC(2026, 5, 1));
const JULY = new Date(Date.UTC(2026, 6, 1));

function ownerSession(partyId: string, orgId = ORG): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 8)}`,
    orgId,
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const agentSession: PortalSessionPayload = {
  userId: "user-agent",
  orgId: ORG,
  role: "viewer",
  userType: "agent",
  partyId: "2c500000-0000-4000-8000-0000000000ae",
  iat: 0,
  absoluteExp: 0,
};

/** Build the app exactly as portal/index.ts mounts it: owner-guard + router at /owner. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/owner/*", portalUserTypeGuard("owner"));
  app.route("/owner", portalOwnerStatementsRoutes);
  return app;
}

async function cleanup() {
  const db = getDb();
  await db.ownerExpenseProof.deleteMany({ where: { organizationId: ORG } });
  await db.invoice.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG2 } });
  await db.organization.deleteMany({ where: { id: ORG2 } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Owner Proof Portal Org",
      slug: "owner-proof-portal-org-2c5",
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
  await db.organization.create({
    data: {
      id: ORG2,
      name: "Owner Proof Portal Org 2",
      slug: "owner-proof-portal-org-2c5-2",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OWNER_C, organizationId: ORG2, displayName: "Owner C", partyType: "individual", status: "active" },
  });

  // POSTED ("sent") owner_statement for A, June 2026, apartment APT_A.
  await db.invoice.create({
    data: {
      id: STMT_A_SENT,
      organizationId: ORG,
      invoiceNumber: "OS-2C5-0001",
      partyId: OWNER_A,
      ownerPartyId: OWNER_A,
      apartmentId: APT_A,
      invoiceType: "owner_statement",
      status: "sent",
      invoiceDate: JUNE,
      periodMonth: JUNE,
      totalAmount: "0.00",
      currency: "MYR",
    },
  });
  // DRAFT owner_statement for A, July 2026, apartment APT_A — post-only gate blocks it.
  await db.invoice.create({
    data: {
      id: STMT_A_DRAFT,
      organizationId: ORG,
      invoiceNumber: "OS-2C5-0002",
      partyId: OWNER_A,
      ownerPartyId: OWNER_A,
      apartmentId: APT_A,
      invoiceType: "owner_statement",
      status: "draft",
      invoiceDate: JULY,
      periodMonth: JULY,
      totalAmount: "0.00",
      currency: "MYR",
    },
  });

  // A bill for the POSTED (June) statement scope.
  await db.ownerExpenseProof.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      statementMonth: JUNE,
      apartmentId: APT_A,
      category: "utilities_tnb",
      storageKey: "owner-statements/A/proofs/tnb.png",
      filename: "tnb.png",
      uploadedById: UPLOADER,
    },
  });
  // A bill for the DRAFT (July) statement scope — proves the gate blocks even when
  // proofs EXIST (the 404 is the status gate, not "no proofs").
  await db.ownerExpenseProof.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      statementMonth: JULY,
      apartmentId: APT_A,
      category: "water",
      storageKey: "owner-statements/A/proofs/water.png",
      filename: "water.png",
      uploadedById: UPLOADER,
    },
  });
}

function proofsReq(session: PortalSessionPayload | null, id: string) {
  return makeApp(session).request(`/owner/statements/${id}/proofs`);
}
function packReq(session: PortalSessionPayload | null, id: string) {
  return makeApp(session).request(`/owner/statements/${id}/proof-pack`);
}

describe.skipIf(!RUN)("portal owner proof routes (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });

  it("(a) flag OFF → 404 (no shape leak)", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await proofsReq(ownerSession(OWNER_A), STMT_A_SENT);
    expect(res.status).toBe(404);
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });

  it("(b) owner A + A's POSTED statement → proofs 200 grouped", async () => {
    const res = await proofsReq(ownerSession(OWNER_A), STMT_A_SENT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].category).toBe("utilities_tnb");
    expect(body.data[0].proofs).toHaveLength(1);
    expect(body.data[0].proofs[0].filename).toBe("tnb.png");
    expect(body.data[0].proofs[0].url).toContain("signed.example");
  });

  it("(b2) owner A + A's POSTED statement → proof-pack 200 application/pdf", async () => {
    const res = await packReq(ownerSession(OWNER_A), STMT_A_SENT);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("(c) owner A + A's OWN DRAFT statement → proofs 404 (post-only gate)", async () => {
    const res = await proofsReq(ownerSession(OWNER_A), STMT_A_DRAFT);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    expect(body.data).toBeUndefined();
  });

  it("(c2) owner A + A's OWN DRAFT statement → proof-pack 404 (post-only gate)", async () => {
    const res = await packReq(ownerSession(OWNER_A), STMT_A_DRAFT);
    expect(res.status).toBe(404);
  });

  it("(d) owner B + A's POSTED statement → proofs 404 (owner-scoping)", async () => {
    const res = await proofsReq(ownerSession(OWNER_B), STMT_A_SENT);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("not_found");
  });

  it("(d2) owner B + A's POSTED statement → proof-pack 404 (owner-scoping)", async () => {
    const res = await packReq(ownerSession(OWNER_B), STMT_A_SENT);
    expect(res.status).toBe(404);
  });

  it("(e) unknown statement id → 404 (no existence leak)", async () => {
    const res = await proofsReq(ownerSession(OWNER_A), UNKNOWN);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("(f) userType guard blocks an agent → 403", async () => {
    const res = await proofsReq(agentSession, STMT_A_SENT);
    expect(res.status).toBe(403);
  });

  it("(g) owner C (org 2) + A's statement (org 1) → 404 (cross-org isolation)", async () => {
    const res = await proofsReq(ownerSession(OWNER_C, ORG2), STMT_A_SENT);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("not_found");
  });
});
