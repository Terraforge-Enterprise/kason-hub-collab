import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src";

// Integration round-trip against the real Postgres (opt-in, mirroring the
// project's RUN_INTEGRATION convention). Without the flag this file is skipped
// so the unit test run stays DB-free; the migration acceptance command runs it
// with RUN_INTEGRATION=1 against the dedicated worktree DB.
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

// This file CREATES a whole org fixture and cascade-deletes it, so refuse any
// non-local DATABASE_URL — the same guard recurring-charges.migration.test.ts uses.
if (RUN_INTEGRATION) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

describe.skipIf(!RUN_INTEGRATION)("GridAttachment.expenseId (T1)", () => {
  // getDb() must NOT be called in the describe body: vitest evaluates that body
  // even when the suite is skipped, so an eager call threw "DATABASE_URL is not
  // set" and failed the file despite the skipIf above. Resolve it per-use instead.
  // Track the one org we create so we can cascade-clean it at the end.
  let createdOrgId: string | null = null;

  afterAll(async () => {
    if (createdOrgId) {
      const db = getDb();
      // Organization cascades to Property → Apartment → Entry → Expense →
      // Attachment (all onDelete: Cascade up the org chain), so one delete
      // tears down the whole fixture.
      await db.organization.delete({ where: { id: createdOrgId } }).catch(() => {});
    }
  });

  async function makeExpense() {
    const db = getDb();
    const org = await db.organization.create({
      data: {
        name: "T1 attach org",
        slug: `t1-attach-${randomUUID()}`,
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    createdOrgId = org.id;
    const property = await db.property.create({
      data: {
        organizationId: org.id,
        name: "T1 property",
        propertyCode: `PC-${randomUUID().slice(0, 8)}`,
        propertyType: "apartment",
        addressLine1: "1 Test St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "unpublished",
      },
    });
    const apartment = await db.apartment.create({
      data: {
        organizationId: org.id,
        propertyId: property.id,
        unitCode: `U-${randomUUID().slice(0, 8)}`,
        listingMode: "WHOLE",
      },
    });
    const periodMonth = new Date("2026-07-01T00:00:00.000Z");
    const entry = await db.unitBillsGridEntry.create({
      data: {
        organizationId: org.id,
        apartmentId: apartment.id,
        periodMonth,
        createdBy: randomUUID(),
      },
    });
    const expense = await db.gridExpense.create({
      data: {
        organizationId: org.id,
        entryId: entry.id,
        apartmentId: apartment.id,
        periodMonth,
        bearer: "tenant",
        description: "Receipt line",
        amount: "12.34",
        createdBy: randomUUID(),
      },
    });
    return { orgId: org.id, apartmentId: apartment.id, entryId: entry.id, periodMonth, expense };
  }

  it("persists and reads back a GridAttachment linked to an expense via expenseId", async () => {
    const db = getDb();
    const { orgId, apartmentId, entryId, periodMonth, expense } = await makeExpense();

    const created = await db.gridAttachment.create({
      data: {
        organizationId: orgId,
        apartmentId,
        periodMonth,
        entryId,
        expenseId: expense.id,
        storageKey: `bills-grid/${orgId}/${entryId}/${expense.id}/${randomUUID()}-r.jpg`,
        filename: "r.jpg",
        contentType: "image/jpeg",
        sizeBytes: 42,
        uploadedBy: randomUUID(),
      },
    });

    const read = await db.gridAttachment.findUniqueOrThrow({ where: { id: created.id } });
    expect(read.expenseId).toBe(expense.id);
  });

  it("allows a null expenseId (legacy/entry-level rows unaffected)", async () => {
    const db = getDb();
    const { orgId, apartmentId, entryId, periodMonth } = await makeExpense();

    const created = await db.gridAttachment.create({
      data: {
        organizationId: orgId,
        apartmentId,
        periodMonth,
        entryId,
        expenseId: null,
        storageKey: `bills-grid/${orgId}/${entryId}/${randomUUID()}-legacy.jpg`,
        filename: "legacy.jpg",
        contentType: "image/jpeg",
        sizeBytes: 7,
        uploadedBy: randomUUID(),
      },
    });

    const read = await db.gridAttachment.findUniqueOrThrow({ where: { id: created.id } });
    expect(read.expenseId).toBeNull();
  });
});
