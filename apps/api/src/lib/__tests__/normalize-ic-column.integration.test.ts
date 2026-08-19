/**
 * SQL <-> TS parity for Party.idNumberNormalized (generated STORED column).
 * Hits a real Postgres. Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run normalize-ic-column
 *
 * Seed pattern (fixed UUIDs, dn/RUN gate, explicit cleanup) mirrors
 * apps/api/src/modules/reservations/__tests__/service.create.integration.test.ts's
 * seedOrgWithUnit(), trimmed to only what Party requires (Organization FK) --
 * no Property/Apartment/Listing needed for this test.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { normalizeIc } from "../normalize-ic";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "88888888-8888-8888-8888-888888888801";
const PARTY = "88888888-8888-8888-8888-888888888802";

async function seedOrgWithParty(idNumber: string | null) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test Org (normalize-ic)",
      slug: "test-normalize-ic",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: {
      id: PARTY,
      organizationId: ORG,
      displayName: "Test Tenant",
      partyType: "tenant",
      status: "active",
      idType: "nric",
      idNumber,
    },
  });
}

async function seedOrgWithParties(parties: Array<{ id: string; idNumber: string }>) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test Org (normalize-ic)",
      slug: "test-normalize-ic",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  for (const { id, idNumber } of parties) {
    await db.party.create({
      data: {
        id,
        organizationId: ORG,
        displayName: "Test Tenant",
        partyType: "tenant",
        status: "active",
        idType: "nric",
        idNumber,
      },
    });
  }
}

async function cleanup() {
  const db = getDb();
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("Party.idNumberNormalized (generated column, integration)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("computes idNumberNormalized = normalizeIc(idNumber), matching the TS helper exactly", async () => {
    await seedOrgWithParty("a1-b2");
    const db = getDb();
    const row = await db.party.findUniqueOrThrow({ where: { id: PARTY } });
    // Cast: field not yet in the generated Prisma client pre-migration (RED),
    // becomes a real typed field post-migration (GREEN).
    const normalized = (row as unknown as { idNumberNormalized: string | null }).idNumberNormalized;
    expect(normalized).toBe("A1B2");
    expect(normalized).toBe(normalizeIc("a1-b2"));
  });

  it("normalizes a null idNumber to empty string, matching the TS helper", async () => {
    await seedOrgWithParty(null);
    const db = getDb();
    const row = await db.party.findUniqueOrThrow({ where: { id: PARTY } });
    const normalized = (row as unknown as { idNumberNormalized: string | null }).idNumberNormalized;
    expect(normalized).toBe("");
    expect(normalized).toBe(normalizeIc(null));
  });

  it("strips non-ASCII characters identically to the TS helper (regex-family parity)", async () => {
    await seedOrgWithParty("护照a1-b2");
    const db = getDb();
    const row = await db.party.findUniqueOrThrow({ where: { id: PARTY } });
    const normalized = (row as unknown as { idNumberNormalized: string | null }).idNumberNormalized;
    expect(normalized).toBe(normalizeIc("护照a1-b2"));
  });

  it("recomputes idNumberNormalized when idNumber changes (STORED, not stale)", async () => {
    await seedOrgWithParty("901010-14-5581");
    const db = getDb();
    await db.party.update({ where: { id: PARTY }, data: { idNumber: "z9-y8" } });
    const row = await db.party.findUniqueOrThrow({ where: { id: PARTY } });
    const normalized = (row as unknown as { idNumberNormalized: string | null }).idNumberNormalized;
    expect(normalized).toBe(normalizeIc("z9-y8"));
  });

  it("cannot be corrupted by a direct write; persisted value always stays SQL-derived", async () => {
    await seedOrgWithParty("a1-b2");
    const db = getDb();
    // Pre-migration: Prisma's currently-generated client doesn't know this field
    // and rejects it itself (unknown argument). Post-migration: Prisma treats it
    // as a plain writable column and forwards the write to Postgres, which
    // rejects it as SQLSTATE 428C9 "column can only be updated to DEFAULT"
    // (verified empirically against local Postgres 16.13 -- see task-3-report.md).
    // Either way the write must not succeed, so we swallow whichever rejection
    // fires and assert on the one thing that actually matters: the persisted
    // value is untouched and still exactly the SQL-derived one.
    await db.party
      .update({ where: { id: PARTY }, data: { idNumberNormalized: "HACK" } as Record<string, unknown> })
      .catch(() => undefined);
    const row = await db.party.findUniqueOrThrow({ where: { id: PARTY } });
    const normalized = (row as unknown as { idNumberNormalized: string | null }).idNumberNormalized;
    expect(normalized).toBe(normalizeIc("a1-b2"));
  });

  it("strips accented Latin characters identically to the TS helper (regression guard for the divergence-prone class: precomposed diacritics + sz-ligature)", async () => {
    const cases = [
      { id: "88888888-8888-8888-8888-888888888803", idNumber: "café" },
      { id: "88888888-8888-8888-8888-888888888804", idNumber: "Straße-1" },
      { id: "88888888-8888-8888-8888-888888888805", idNumber: "Zoë-90" },
      { id: "88888888-8888-8888-8888-888888888806", idNumber: "Muñoz1" },
    ];
    await seedOrgWithParties(cases);
    const db = getDb();
    for (const { id, idNumber } of cases) {
      const row = await db.party.findUniqueOrThrow({ where: { id } });
      const normalized = (row as unknown as { idNumberNormalized: string | null }).idNumberNormalized;
      expect(normalized).toBe(normalizeIc(idNumber));
    }
  });
});
