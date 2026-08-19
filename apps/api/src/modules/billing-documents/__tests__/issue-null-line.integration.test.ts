import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { issueDocumentTx, DocumentReferenceRequiredError } from "../issue.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "9c350000-0000-4000-8000-000000000001";
const USER = "9c350000-0000-4000-8000-000000000002";
const PARTY = "9c350000-0000-4000-8000-000000000003";
const SERIES_CN = "9c350000-0000-4000-8000-000000000004";
const SERIES_DEP = "9c350000-0000-4000-8000-000000000005";
const ORIG_DOC = "9c350000-0000-4000-8000-000000000006";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  // DEVIATION (T2): plan's cleanup omitted auditLog.deleteMany — issueDocumentTx
  // writes an AuditLog row (actorUserId FK), so User cleanup FK-violates without
  // this line first. Reconciled against the real recordAudit call.
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "P4 NullLine Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "p4nl@test.local", passwordHash: "x", role: "accountant", fullName: "P4 Acc", status: "active", userType: "operator" },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "NL Tenant", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.billingDocument.create({
    data: { id: ORIG_DOC, organizationId: ORG, docType: "debit_note", documentNumber: "DEP-9501", seriesId: SERIES_DEP, status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: PARTY, subtotal: "100.00", sstAmount: "0", total: "100.00" },
  });
}

dn("issueDocumentTx null-line tolerance (integration)", () => {
  afterAll(cleanup);

  it("issues a CN with a charge-less, category-less line", async () => {
    const db = getDb();
    await cleanup();
    await seed();
    const res = await db.$transaction((tx) =>
      issueDocumentTx(tx, {
        organizationId: ORG, docType: "credit_note", seriesCode: "CN",
        counterpartyType: "tenant", partyId: PARTY, originalDocumentId: ORIG_DOC,
        creditAmount: "50.00", reason: "overpayment",
        lines: [{ description: "Overpayment credit", amount: "50.00", sstRate: "0" }],
        actorUserId: USER,
      }),
    );
    expect(res.documentNumber).toMatch(/^CN-\d{4}$/);
    const line = await db.billingDocumentLine.findFirstOrThrow({ where: { documentId: res.id } });
    expect(line.chargeId).toBeNull();
    expect(line.categoryId).toBeNull();
    expect(Number(line.amount.toString())).toBe(50);
  });

  it("still throws when a credit_note has no originalDocumentId", async () => {
    const db = getDb();
    await cleanup();
    await seed();
    await expect(
      db.$transaction((tx) =>
        issueDocumentTx(tx, {
          organizationId: ORG, docType: "credit_note", seriesCode: "CN",
          counterpartyType: "tenant", partyId: PARTY,
          lines: [{ description: "x", amount: "10.00", sstRate: "0" }],
          actorUserId: USER,
        }),
      ),
    ).rejects.toBeInstanceOf(DocumentReferenceRequiredError);
  });
});
