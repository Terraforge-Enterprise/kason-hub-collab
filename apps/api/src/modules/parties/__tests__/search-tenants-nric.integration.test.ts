/**
 * Integration test for searchTenants() matching on normalized NRIC/IC (Task 4, R3).
 * Hits a real Postgres. Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run search-tenants-nric
 *
 * Seed pattern (fixed UUIDs, dn/RUN gate, explicit cleanup) mirrors
 * apps/api/src/lib/__tests__/normalize-ic-column.integration.test.ts, extended
 * with a PartyRole("tenant") row per party since searchTenants() filters on
 * `roles: { some: { roleType: "tenant" } }`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { searchTenants } from "../parties.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "99999999-9999-9999-9999-999999999901";
const TENANT_ACTIVE_IC = "99999999-9999-9999-9999-999999999902";
const TENANT_BLACKLISTED_SAME_IC = "99999999-9999-9999-9999-999999999903";
const TENANT_NAME_MATCH = "99999999-9999-9999-9999-999999999904";
const TENANT_IDLESS_1 = "99999999-9999-9999-9999-999999999905";
const TENANT_IDLESS_2 = "99999999-9999-9999-9999-999999999906";

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Test Org (search-tenants-nric)",
      slug: "test-search-tenants-nric",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

async function seedTenant(
  id: string,
  opts: { displayName: string; idNumber: string | null; status?: string },
) {
  const db = getDb();
  await db.party.create({
    data: {
      id,
      organizationId: ORG,
      displayName: opts.displayName,
      partyType: "tenant",
      status: opts.status ?? "active",
      idType: opts.idNumber ? "nric" : null,
      idNumber: opts.idNumber,
    },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: id, roleType: "tenant", status: "active" },
  });
}

async function cleanup() {
  const db = getDb();
  await db.partyRole.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("searchTenants — normalized NRIC matching (integration, R3)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });
  afterAll(cleanup);

  it("matches a tenant by normalized IC even when displayName doesn't contain the query", async () => {
    await seedTenant(TENANT_ACTIVE_IC, { displayName: "Chong Wei Ling", idNumber: "901010-14-5581" });
    const rows = await searchTenants(ORG, "901010145581", 20);
    expect(rows.map((r) => r.id)).toEqual([TENANT_ACTIVE_IC]);
  });

  it("excludes a blacklisted tenant even when their IC matches q (two tenants, matching IC, only active returns)", async () => {
    await seedTenant(TENANT_ACTIVE_IC, { displayName: "Active Twin", idNumber: "770707-07-7070" });
    await seedTenant(TENANT_BLACKLISTED_SAME_IC, {
      displayName: "Blacklisted Twin",
      idNumber: "770707-07-7070",
      status: "blacklisted",
    });
    const rows = await searchTenants(ORG, "770707077070", 20);
    expect(rows.map((r) => r.id)).toEqual([TENANT_ACTIVE_IC]);
  });

  it("still matches by displayName (regression)", async () => {
    await seedTenant(TENANT_NAME_MATCH, { displayName: "Nurul Izzah", idNumber: null });
    const rows = await searchTenants(ORG, "nurul", 20);
    expect(rows.map((r) => r.id)).toEqual([TENANT_NAME_MATCH]);
  });

  it("does NOT return id-less parties for a punctuation-only query (empty-normalized-key guard)", async () => {
    // Both normalize to "" via normalizeIc: null idNumber and a separator-only
    // idNumber collapse to the same empty key. A naive `idNumberNormalized:
    // normalizeIc(q)` OR-branch would match both of these when q="-" (also
    // normalizes to ""), even though neither displayName nor a real IC matches.
    await seedTenant(TENANT_IDLESS_1, { displayName: "No Ic Alpha", idNumber: null });
    await seedTenant(TENANT_IDLESS_2, { displayName: "No Ic Beta", idNumber: "--" });
    const rows = await searchTenants(ORG, "-", 20);
    expect(rows).toEqual([]);
  });

  it("does NOT return id-less parties for a whitespace-only query either", async () => {
    await seedTenant(TENANT_IDLESS_1, { displayName: "No Ic Alpha", idNumber: null });
    const rows = await searchTenants(ORG, "   ", 20);
    expect(rows).toEqual([]);
  });
});
