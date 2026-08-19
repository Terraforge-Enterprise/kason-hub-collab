/**
 * Integration tests for the OwnerExpenseProof repository (Task B1). Hits a real
 * LOCAL Postgres (kason_hub_test). Skipped by default in `npx vitest run`. Run:
 *   RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_test" \
 *     npx vitest run src/modules/owner-billing/__tests__/owner-expense-proof.repository.test.ts
 *
 * The proof store is keyed (org, owner, statementMonth, apartmentId, category) so it
 * survives owner-ledger re-sync AND two apartments' same-category bills never
 * cross-bind. The apartmentId filter is EXACT — including matching `null`.
 *
 * OwnerExpenseProof's only FK is organization → Organization, so the harness seeds
 * just two orgs; ownerPartyId / apartmentId / uploadedById are plain columns
 * (mirrors OwnerLedgerEntry) and use fixed UUIDs without seeding Party/Apartment.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import {
  appendProof,
  deleteProof,
  findProofById,
  findProofsForOwnerMonth,
} from "../owner-expense-proof.repository";

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

// statementMonth is always normalized to first-of-month UTC by the caller.
const JUNE = new Date(Date.UTC(2026, 5, 1));
const JULY = new Date(Date.UTC(2026, 6, 1));

type AppendInput = Parameters<typeof appendProof>[1];

/** appendProof a (ORG_A, OWNER_A, JUNE, APT_A, "utilities_tnb") proof; override any field. */
function append(over: Partial<AppendInput> = {}) {
  return getDb().$transaction((tx) =>
    appendProof(tx, {
      orgId: ORG_A,
      ownerPartyId: OWNER_A,
      statementMonth: JUNE,
      apartmentId: APT_A,
      category: "utilities_tnb",
      storageKey: `owner-statements/${OWNER_A}/proofs/${crypto.randomUUID()}.pdf`,
      filename: "tnb-june.pdf",
      uploadedById: UPLOADER,
      ...over,
    }),
  );
}

async function seedOrgs() {
  const db = getDb();
  for (const [id, slug] of [
    [ORG_A, "oep-int-org-a"],
    [ORG_B, "oep-int-org-b"],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name: `OEP Int ${slug}`,
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

dn("OwnerExpenseProof repository (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrgs();
  });

  afterAll(async () => {
    await cleanup();
    const db = getDb();
    const orgs = { in: [ORG_A, ORG_B] };
    expect(await db.ownerExpenseProof.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.organization.count({ where: { id: orgs } })).toBe(0);
  });

  it("appendProof persists a row found by the matching (owner, month, apartment, category)", async () => {
    const created = await append({ filename: "tnb-june.pdf" });
    expect(created.id).toBeTruthy();
    expect(created.organizationId).toBe(ORG_A);
    expect(created.ownerPartyId).toBe(OWNER_A);
    expect(created.apartmentId).toBe(APT_A);
    expect(created.category).toBe("utilities_tnb");
    expect(created.filename).toBe("tnb-june.pdf");

    const rows = await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(created.id);
    expect(rows[0]!.category).toBe("utilities_tnb");
  });

  it("the SAME query with a DIFFERENT apartment returns [] (per-apartment guarantee)", async () => {
    await append();
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_B)).toEqual([]);
  });

  it("a different statementMonth returns []", async () => {
    await append();
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JULY, APT_A)).toEqual([]);
  });

  it("apartmentId filter is EXACT incl. null — a null-apartment proof matches only the null query", async () => {
    const nullApt = await append({ apartmentId: null });

    const nullRows = await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, null);
    expect(nullRows).toHaveLength(1);
    expect(nullRows[0]!.id).toBe(nullApt.id);

    // a null-apartment (legacy combined) proof must NOT leak into an apartment-scoped query
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A)).toEqual([]);
  });

  it("cross-org isolation: org B cannot read org A's proof", async () => {
    await append();
    expect(await findProofsForOwnerMonth(ORG_B, OWNER_A, JUNE, APT_A)).toEqual([]);
  });

  it("findProofById is org-scoped; deleteProof removes the row in-tx", async () => {
    const created = await append();

    expect((await findProofById(ORG_A, created.id))?.id).toBe(created.id);
    expect(await findProofById(ORG_B, created.id)).toBeNull();

    await getDb().$transaction((tx) => deleteProof(tx, ORG_A, created.id));

    expect(await findProofById(ORG_A, created.id)).toBeNull();
    expect(await findProofsForOwnerMonth(ORG_A, OWNER_A, JUNE, APT_A)).toEqual([]);
  });
});
