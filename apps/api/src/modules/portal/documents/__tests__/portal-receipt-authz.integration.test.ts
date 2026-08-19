import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { listTenantBillingDocuments, findOwnTenantBillingDocument } from "../portal.documents.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "9c370000-0000-4000-8000-000000000001";
const ORG2 = "9c370000-0000-4000-8000-0000000000a1";
const USER = "9c370000-0000-4000-8000-000000000002";
const TENANT = "9c370000-0000-4000-8000-000000000003";
const OWNER = "9c370000-0000-4000-8000-000000000004";
const SERIES = "9c370000-0000-4000-8000-000000000005";
const RCPT_TENANT = "9c370000-0000-4000-8000-000000000006";
const RCPT_OWNER = "9c370000-0000-4000-8000-000000000007";

async function cleanup() {
  const db = getDb();
  for (const org of [{ organizationId: ORG }, { organizationId: ORG2 }]) {
    await db.billingDocumentLine.deleteMany({ where: { document: org } });
    await db.billingDocument.deleteMany({ where: org });
    await db.documentSeries.deleteMany({ where: org });
    await db.party.deleteMany({ where: org });
  }
  await db.user.deleteMany({ where: { id: USER } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, ORG2] } } });
}

async function seed() {
  const db = getDb();
  for (const id of [ORG, ORG2]) {
    await db.organization.create({
      data: { id, name: `P4 Portal Org ${id.slice(-2)}`, slug: `org-${id}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
    });
  }
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "p4portal@test.local", passwordHash: "x", role: "accountant", fullName: "P4 Acc", status: "active", userType: "operator" },
  });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Portal Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Portal Owner", partyType: "individual", status: "active" } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "RCPT", prefix: "RCPT", padding: 4, includeYear: false, active: true } });

  // T's receipt (counterpartyType tenant) and O's receipt (counterpartyType owner)
  await db.billingDocument.create({
    data: { id: RCPT_TENANT, organizationId: ORG, docType: "receipt", documentNumber: "RCPT-0001", seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT, subtotal: "50.00", sstAmount: "0", total: "50.00" },
  });
  await db.billingDocument.create({
    data: { id: RCPT_OWNER, organizationId: ORG, docType: "receipt", documentNumber: "RCPT-0002", seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "owner", partyId: OWNER, subtotal: "80.00", sstAmount: "0", total: "80.00" },
  });
}

dn("portal receipt authz (R16, integration)", () => {
  afterAll(cleanup);

  it("tenant sees only their own-counterparty receipt; owner-counterparty receipt does not leak", async () => {
    await cleanup(); await seed();
    const rows = await listTenantBillingDocuments({ partyId: TENANT, orgId: ORG });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(RCPT_TENANT);
    expect(ids).not.toContain(RCPT_OWNER);
  });

  it("PDF-route own-doc check 404s (returns null) for an owner-counterparty receipt", async () => {
    await cleanup(); await seed();
    const own = await findOwnTenantBillingDocument({ partyId: TENANT, orgId: ORG }, RCPT_OWNER);
    expect(own).toBeNull();
    const mine = await findOwnTenantBillingDocument({ partyId: TENANT, orgId: ORG }, RCPT_TENANT);
    expect(mine?.id).toBe(RCPT_TENANT);
  });

  it("PDF-route own-doc check 404s (returns null) cross-org", async () => {
    await cleanup(); await seed();
    const own = await findOwnTenantBillingDocument({ partyId: TENANT, orgId: ORG2 }, RCPT_TENANT);
    expect(own).toBeNull();
  });
});
