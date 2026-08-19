/**
 * issueDocumentsForChargesTx — in-transaction auto-post minting (+ the
 * never-throw healing wrapper). Real local Postgres.
 * Run: RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 npx vitest run src/modules/billing-documents/__tests__/issue-for-charges.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@kason/db";
import {
  DocumentCategoryUnresolvedError,
  healBillingDocumentsForCharges,
  issueDocumentsForChargesTx,
} from "../issue.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "17171717-1717-4171-8171-171717171717";
let actorId = "";
let tenantPartyId = "";
let utilChargeId = "";
let rentChargeId = "";
let draftChargeId = "";

async function cleanOrg() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "IFC Test Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  // AuditLog.actorUserId FK → User.id (onDelete: Restrict): acting user must exist
  // (recordAudit writes actorUserId = ACTOR — same precedent as Task 4's suite).
  const actor = await db.user.create({
    data: {
      organizationId: ORG, email: `ifc-actor-${ORG}@test.local`, passwordHash: "x",
      fullName: "Actor", role: "admin", status: "active",
    },
  });
  actorId = actor.id;
  const party = await db.party.create({
    data: { organizationId: ORG, partyType: "tenant", displayName: "Tenant A", status: "active" },
  });
  tenantPartyId = party.id;
  // Series + categories seeded DIRECTLY (test independence from Plan 1's
  // lazy ensureChargeCategorySeeds; issueDocumentsForChargesTx still calls
  // it — idempotent create-only upserts, so these rows survive).
  const dep = await db.documentSeries.create({
    data: { organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  for (const [code, ledger] of [["rental", "rental_income"], ["utility_tnb", "utility_tnb"], ["aircond", "aircond_income"]] as const) {
    await db.chargeCategory.create({
      data: {
        organizationId: ORG, code, name: code, family: "pay_back_landlord", docType: "debit_note",
        seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: ledger,
        isSystem: true, active: true, sortOrder: 1,
      },
    });
  }
  const mkCharge = (n: string, type: string, status: string) =>
    db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: n, partyId: tenantPartyId, chargeType: type, status,
        dueDate: new Date("2026-07-31T00:00:00.000Z"), postedAt: status === "posted" ? new Date() : null,
        amount: "100.00", currency: "MYR", outstandingAmount: "100.00", attachmentKeys: [],
        billingMonth: new Date("2026-07-01T00:00:00.000Z"),
      },
      select: { id: true },
    });
  utilChargeId = (await mkCharge("UTIL-2026-07-u1", "utility", "posted")).id;
  rentChargeId = (await mkCharge("RENT-2026-07-t1", "rent", "posted")).id;
  draftChargeId = (await mkCharge("DRAFT-2026-07-x", "utility", "draft")).id;
}

/** Helper: run the mint inside a fresh tx, the way the posting flows do. */
async function mintInTx(chargeIds: string[]) {
  const db = getDb();
  await db.$transaction((tx) => issueDocumentsForChargesTx(tx, chargeIds, actorId));
}

async function mkOddCharge() {
  const db = getDb();
  return db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: "ODD-1", partyId: tenantPartyId, chargeType: "mystery",
      status: "posted", postedAt: new Date(), dueDate: new Date(), amount: "5.00", currency: "MYR",
      outstandingAmount: "5.00", attachmentKeys: [],
    },
    select: { id: true },
  });
}

dn("issueDocumentsForChargesTx — integration", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    await cleanOrg();
    await seed();
  });
  afterEach(() => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  });

  it("issues one DEP debit note per posted charge inside the caller's tx; drafts get nothing", async () => {
    await mintInTx([utilChargeId, rentChargeId, draftChargeId]);
    const db = getDb();
    const docs = await db.billingDocument.findMany({
      where: { organizationId: ORG },
      include: { lines: true },
      orderBy: { documentNumber: "asc" },
    });
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d.docType).toBe("debit_note");
      expect(d.counterpartyType).toBe("tenant");
      expect(d.lines).toHaveLength(1);
      expect(d.total.toString()).toBe("100");
    }
    const draftLines = await db.billingDocumentLine.findMany({ where: { chargeId: draftChargeId } });
    expect(draftLines).toHaveLength(0);
  });

  it("back-fills charge.categoryId from the chargeType map (in the same tx)", async () => {
    await mintInTx([utilChargeId]);
    const charge = await getDb().charge.findUniqueOrThrow({ where: { id: utilChargeId }, select: { categoryId: true } });
    const cat = await getDb().chargeCategory.findFirst({ where: { organizationId: ORG, code: "utility_tnb" }, select: { id: true } });
    expect(charge.categoryId).toBe(cat!.id);
  });

  it("replay is a no-op (idempotency key + existing-line skip)", async () => {
    await mintInTx([utilChargeId]);
    await mintInTx([utilChargeId]);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it("a mint failure ABORTS the whole posting tx — companion writes and sibling documents roll back (spec §4.6)", async () => {
    const db = getDb();
    const odd = await mkOddCharge(); // unmapped chargeType "mystery" → DocumentCategoryUnresolvedError
    await expect(
      db.$transaction(async (tx) => {
        // Simulate the posting tx: a companion write that must vanish with the rollback.
        await tx.charge.update({ where: { id: utilChargeId }, data: { description: "posting-tx marker" } });
        await issueDocumentsForChargesTx(tx, [utilChargeId, odd.id], actorId);
      }),
    ).rejects.toBeInstanceOf(DocumentCategoryUnresolvedError);
    // NOTHING survived: not even the mapped util charge's document, nor the companion write.
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocumentLine.count({ where: { chargeId: utilChargeId } })).toBe(0);
    const util = await db.charge.findUniqueOrThrow({ where: { id: utilChargeId }, select: { description: true } });
    expect(util.description).not.toBe("posting-tx marker");
  });

  it("flag dark → early-return, no documents", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await mintInTx([utilChargeId]);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });
});

dn("healBillingDocumentsForCharges — integration (healing/backfill wrapper)", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    await cleanOrg();
    await seed();
  });
  afterEach(() => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  });

  it("heals a legacy documented-less charge in its own tx", async () => {
    await healBillingDocumentsForCharges([utilChargeId], actorId);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it("NEVER throws — a failure leaves the durable billing_documents.mint_failed audit marker", async () => {
    const db = getDb();
    const odd = await mkOddCharge();
    await expect(healBillingDocumentsForCharges([odd.id], actorId)).resolves.toBeUndefined();
    expect(await db.billingDocumentLine.count({ where: { chargeId: odd.id } })).toBe(0);
    const marker = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "billing_documents.mint_failed" },
    });
    expect(marker).not.toBeNull();
  });
});
