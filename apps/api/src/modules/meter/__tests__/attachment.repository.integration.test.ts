/**
 * Bill-attachment repository CRUD (integration, RUN_INTEGRATION=1).
 *
 * Exercises create → list → delete against the real local Postgres. Seeds a
 * minimal org + apartment + DRAFT UnitUtilityBill directly (the repository
 * layer doesn't need an occupied tenancy — that's createUtilityBillService's
 * concern, not this one's).
 *
 * Run:
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run src/modules/meter/__tests__/attachment.repository.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { createBillAttachment, listBillAttachments, deleteBillAttachment } from "../repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix ba77)
const ORG = "ba770000-0000-4000-8000-000000000001";
const USER = "ba770000-0000-4000-8000-000000000002";
const PROP = "ba770000-0000-4000-8000-000000000003";
const APT = "ba770000-0000-4000-8000-000000000004";
const BILL = "ba770000-0000-4000-8000-000000000005";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.unitUtilityBillAttachment.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedDraftBill() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Attachment Repo Org", slug: "attachment-repo-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "attach@example.test", fullName: "Attach Uploader", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  const bill = await db.unitUtilityBill.create({ data: { id: BILL, organizationId: ORG, apartmentId: APT, periodMonth: new Date("2026-06-01"), billingMode: "whole", tnbTotal: "10.00", createdBy: USER } });
  return { orgId: ORG, billId: bill.id, userId: USER };
}

dn("bill attachment repository (integration)", () => {
  beforeEach(async () => {
    await cleanup();
  });

  it("creates, lists, and deletes an attachment", async () => {
    const { orgId, billId, userId } = await seedDraftBill();
    const db = getDb();

    const created = await createBillAttachment(db, { organizationId: orgId, billId, storageKey: "utility-bills/x/a.pdf", filename: "TNB.pdf", uploadedById: userId });
    expect(created.filename).toBe("TNB.pdf");

    const list = await listBillAttachments(db, orgId, billId);
    expect(list.map((a) => a.id)).toContain(created.id);

    await deleteBillAttachment(db, orgId, created.id);
    expect(await listBillAttachments(db, orgId, billId)).toHaveLength(0);
  });
});
