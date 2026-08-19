/**
 * Integration tests for the OwnerExpenseProof SERVICE (Task B2). The repository
 * hits a real LOCAL Postgres (kason_hub_test); storage + audit are MOCKED so the
 * service runs without a real Supabase bucket and without an AuditLog→User FK to
 * seed. Skipped by default in `npx vitest run`. Run:
 *   RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_test" \
 *     npx vitest run src/modules/owner-billing/__tests__/owner-expense-proof.service.test.ts
 *
 * Mirrors the receipts-service idiom (mime gate, server-minted key, putObject,
 * createSignedDownloadUrl INLINE) but the proof store is keyed
 * (org, owner, statementMonth, apartmentId, category) — so two apartments' same
 * category never cross-bind (APT_B returns it NOT) — and detach is NO-ORPHAN
 * (deletes the bucket object after the row, unlike the receipts detach).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Storage mocked: spies so the service runs without a real Supabase bucket.
// createSignedDownloadUrl returns a deterministic per-key URL; requireBucket a
// fixed bucket name; deleteObject a recorded no-op (asserts the no-orphan delete).
vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}?token=t`),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));
// Audit mocked → the in-tx audit write is a no-op (no User FK to seed).
vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import { getDb } from "@kason/db";
import { createSignedDownloadUrl, deleteObject, putObject } from "../../../lib/storage";
import { findProofsForOwnerMonth } from "../owner-expense-proof.repository";
import {
  attachExpenseProofService,
  detachExpenseProofService,
  listExpenseProofUrlsService,
  type ProofFile,
} from "../owner-expense-proof.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from every other integration test's constants.
const ORG_A = "0e000000-0000-4000-8000-0000000000a1";
const ORG_B = "0e000000-0000-4000-8000-0000000000b1";
const OWNER_A = "0e000000-0000-4000-8000-0000000000a4";
const APT_A = "0e000000-0000-4000-8000-0000000000c1";
const APT_B = "0e000000-0000-4000-8000-0000000000c2";
const UPLOADER = "0e000000-0000-4000-8000-0000000000a2";

const MONTH = "2026-06";
const JUNE = new Date(Date.UTC(2026, 5, 1));

const ctxA = { orgId: ORG_A, actorUserId: UPLOADER, actorRole: "admin" as const };
const ctxB = { orgId: ORG_B, actorUserId: UPLOADER, actorRole: "admin" as const };

const png = (name = "tnb.png"): ProofFile => ({
  filename: name,
  mimeType: "image/png",
  content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
});
const exe = (): ProofFile => ({
  filename: "x.exe",
  mimeType: "application/x-msdownload",
  content: Buffer.from("MZ"),
});

// Server-minted key under owner-statements/<owner>/proofs/<uuid>.<ext> (NOT receipts/).
const PROOF_KEY_RE = new RegExp(`^owner-statements/${OWNER_A}/proofs/[0-9a-f-]{36}\\.png$`);

async function seedOrgs() {
  const db = getDb();
  for (const [id, slug] of [
    [ORG_A, "oep-svc-org-a"],
    [ORG_B, "oep-svc-org-b"],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name: `OEP Svc ${slug}`,
        slug,
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
  }
}

async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG_A, ORG_B] };
  await db.ownerExpenseProof.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanup();
  await seedOrgs();
});

afterAll(async () => {
  await cleanup();
});

dn("attachExpenseProofService (integration)", () => {
  it("attaches a PNG → object put (server-minted key) + row persisted + listable grouped by category", async () => {
    const result = await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [png("tnb-june.png")],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    // object: putObject called with a server-minted proofs/<uuid>.png key
    expect(putObject).toHaveBeenCalledTimes(1);
    const key = vi.mocked(putObject).mock.calls[0]![0] as string;
    expect(key).toMatch(PROOF_KEY_RE);

    // row: persisted in the test DB under (org, owner, month, APT_A, category)
    const rows = await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("utilities_tnb");
    expect(rows[0]!.filename).toBe("tnb-june.png");
    expect(rows[0]!.storageKey).toBe(key);
    expect(rows[0]!.uploadedById).toBe(UPLOADER);

    // list: grouped by category with a signed url; signed INLINE (no filename opt)
    const list = await listExpenseProofUrlsService(ctxA, OWNER_A, MONTH, APT_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.status).toBe(200);
    expect(list.data).toEqual([
      {
        category: "utilities_tnb",
        proofs: [
          {
            id: rows[0]!.id,
            filename: "tnb-june.png",
            url: `https://signed.example/${key}?token=t`,
            // Additive (Task 4 delegation to resolveStatementBills): every manual proof is
            // tagged source:"manual"/readOnly:false — the pre-delegation shape minus these
            // two fields is otherwise unchanged (same category/id/filename/url).
            source: "manual",
            readOnly: false,
          },
        ],
      },
    ]);
    // INLINE = createSignedDownloadUrl(key) with NO opts (renders, not downloads).
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(key);
  });

  it("groups multiple categories; proofs nest under their own category", async () => {
    await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [png("tnb.png")],
    );
    await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "water" },
      [png("water.png")],
    );

    const list = await listExpenseProofUrlsService(ctxA, OWNER_A, MONTH, APT_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const cats = list.data.map((g) => g.category).sort();
    expect(cats).toEqual(["utilities_tnb", "water"]);
    for (const g of list.data) expect(g.proofs).toHaveLength(1);
  });

  it("the same list with a DIFFERENT apartment returns it NOT (per-apartment guarantee)", async () => {
    await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [png()],
    );
    const list = await listExpenseProofUrlsService(ctxA, OWNER_A, MONTH, APT_B);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data).toEqual([]);
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("cross-org list returns [] (org B cannot read org A's proof)", async () => {
    await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [png()],
    );
    const list = await listExpenseProofUrlsService(ctxB, OWNER_A, MONTH, APT_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data).toEqual([]);
  });

  it("400s a bad mime — no object, no row", async () => {
    const result = await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [exe()],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(putObject).not.toHaveBeenCalled();
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A)).toEqual([]);
  });

  it("400s an empty upload (no files) — no object, no row", async () => {
    const result = await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("attaches with a null apartment (legacy combined) — keyed apartmentId IS NULL", async () => {
    await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: null, category: "utilities_tnb" },
      [png()],
    );
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, null)).toHaveLength(1);
    // null-apartment proof must NOT leak into an apartment-scoped list
    const list = await listExpenseProofUrlsService(ctxA, OWNER_A, MONTH, APT_A);
    expect(list.ok && list.data).toEqual([]);
  });
});

dn("detachExpenseProofService (integration)", () => {
  it("removes the row AND deletes the bucket object after commit (NO ORPHAN)", async () => {
    const attach = await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [png()],
    );
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;
    const proofId = attach.data[0]!.id;
    const key = vi.mocked(putObject).mock.calls[0]![0] as string;

    const result = await detachExpenseProofService(ctxA, proofId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);

    // row gone
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A)).toEqual([]);
    // object deleted (NO ORPHAN) — deleteObject(requireBucket(), key)
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith("test-bucket", key);
  });

  it("404s a cross-org proofId — no delete, row untouched", async () => {
    const attach = await attachExpenseProofService(
      ctxA,
      { ownerPartyId: OWNER_A, statementMonth: MONTH, apartmentId: APT_A, category: "utilities_tnb" },
      [png()],
    );
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;
    const proofId = attach.data[0]!.id;

    const result = await detachExpenseProofService(ctxB, proofId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A)).toHaveLength(1);
  });

  it("404s an unknown proofId — no delete", async () => {
    const result = await detachExpenseProofService(ctxA, "0e000000-0000-4000-8000-0000000000ff");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
