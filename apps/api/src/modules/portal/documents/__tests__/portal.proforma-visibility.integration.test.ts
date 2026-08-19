/**
 * R9 — a REPLACED proforma is never shown to a tenant.
 *
 * A proforma is a request for payment the workflow replaces whole whenever the month's
 * charges change. Once re-billing is routine a tenant would otherwise open Documents and
 * find three PI- numbers for one month with no way to tell which to pay.
 *
 * Scoped to proforma deliberately: a CANCELLED invoice or credit note is a real record
 * and stays visible, which this file also pins.
 *
 * Both the LIST and the PDF-by-id gate must apply the same filter — a document hidden
 * from the list but still downloadable by id is the more damaging leak of the two.
 *
 * Real local Postgres. Run (from apps/api):
 *   RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/portal/documents/__tests__/portal.proforma-visibility.integration.test.ts
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listTenantBillingDocuments, findOwnTenantBillingDocument } from "../portal.documents.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB: ${host}`);
}

const ORG = "d5000000-0000-4000-8000-000000000001";
const USER = "d5000000-0000-4000-8000-000000000002";
const PARTY = "d5000000-0000-4000-8000-000000000003";
const OTHER_PARTY = "d5000000-0000-4000-8000-000000000004";
const SERIES = "d5000000-0000-4000-8000-000000000005";

const scope = { partyId: PARTY, orgId: ORG };

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Vis Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "v@t.test", fullName: "V", status: "active", role: "admin", userType: "operator" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "tenant", status: "active" } });
  await db.party.create({ data: { id: OTHER_PARTY, organizationId: ORG, displayName: "Someone Else", partyType: "tenant", status: "active" } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "PI", prefix: "PI", padding: 4, includeYear: false, active: true } });
}

let n = 0;
async function makeDoc(opts: { docType: string; documentStatus: string; partyId?: string }) {
  const db = getDb();
  n += 1;
  return db.billingDocument.create({
    data: {
      organizationId: ORG, docType: opts.docType, documentNumber: `VIS-${n}`, seriesId: SERIES,
      issuedById: USER, counterpartyType: "tenant", partyId: opts.partyId ?? PARTY,
      subtotal: "100.00", sstAmount: "0", total: "100.00", documentStatus: opts.documentStatus,
    },
    select: { id: true },
  });
}

dn("tenant proforma visibility (R9)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });
  afterEach(cleanup);

  it("hides a CANCELLED proforma from the tenant's register", async () => {
    const live = await makeDoc({ docType: "proforma", documentStatus: "ISSUED" });
    const replaced = await makeDoc({ docType: "proforma", documentStatus: "CANCELLED" });

    const rows = await listTenantBillingDocuments(scope);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(replaced.id);
  });

  it("also refuses it by id, so it cannot be downloaded behind the list's back", async () => {
    const replaced = await makeDoc({ docType: "proforma", documentStatus: "CANCELLED" });
    expect(await findOwnTenantBillingDocument(scope, replaced.id)).toBeNull();
  });

  it("a CANCELLED INVOICE stays visible — it is a real record, not a replaced request", async () => {
    const voided = await makeDoc({ docType: "invoice", documentStatus: "CANCELLED" });
    const rows = await listTenantBillingDocuments(scope);
    expect(rows.map((r) => r.id)).toContain(voided.id);
    expect(await findOwnTenantBillingDocument(scope, voided.id)).not.toBeNull();
  });

  it("never leaks another tenant's proforma", async () => {
    const theirs = await makeDoc({ docType: "proforma", documentStatus: "ISSUED", partyId: OTHER_PARTY });
    const rows = await listTenantBillingDocuments(scope);
    expect(rows.map((r) => r.id)).not.toContain(theirs.id);
    expect(await findOwnTenantBillingDocument(scope, theirs.id)).toBeNull();
  });
});
