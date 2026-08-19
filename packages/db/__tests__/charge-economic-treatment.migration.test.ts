import { describe, it, expect } from "vitest";
import { getDb } from "../src/client";

// Real local Postgres only — opt in with RUN_INTEGRATION=1, mirroring the
// convention in recurring-charges.migration.test.ts. This file CREATES and
// DELETES Charge rows, so the non-local host guard below is load-bearing: without
// it, `turbo run test` would write to whatever DATABASE_URL happens to name
// (UAT/prod DSNs included). Without the flag the file is skipped, so a plain
// test run stays DB-free; previously it threw "DATABASE_URL is not set".
//
// getDb() is called INSIDE each test, never in the describe body — vitest
// evaluates a describe callback even when it is skipped, so an eager getDb()
// throws before the skip can take effect (that was the original failure).
// Run: from repo root
//   set -a; . ./.env; set +a; RUN_INTEGRATION=1 npx vitest run packages/db/__tests__/charge-economic-treatment.migration.test.ts
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

dn("charge economic-treatment columns", () => {
  it("stores fundedBy/revenueRecognition/taxTreatment on Charge", async () => {
    const db = getDb();
    const org = await db.organization.findFirstOrThrow({ select: { id: true } });
    const party = await db.party.findFirstOrThrow({ where: { organizationId: org.id }, select: { id: true } });
    const c = await db.charge.create({
      data: {
        organizationId: org.id, chargeNumber: `ETEST-${Date.now()}`, partyId: party.id,
        chargeType: "utility", status: "posted", dueDate: new Date(), amount: "1.00",
        currency: "MYR", outstandingAmount: "1.00",
        fundedBy: "manager", revenueRecognition: "recovery_of_advance",
        settlementRecipient: "manager", sourceSupplier: "TNB", taxTreatment: "out_of_scope_disbursement",
      },
      select: { fundedBy: true, revenueRecognition: true, taxTreatment: true },
    });
    expect(c).toEqual({ fundedBy: "manager", revenueRecognition: "recovery_of_advance", taxTreatment: "out_of_scope_disbursement" });
    await db.charge.deleteMany({ where: { chargeNumber: { startsWith: "ETEST-" } } });
  });

  it("reads existing rows with the new economic-treatment columns as null (forward-only, no backfill)", async () => {
    const db = getDb();
    const org = await db.organization.findFirstOrThrow({ select: { id: true } });
    const party = await db.party.findFirstOrThrow({ where: { organizationId: org.id }, select: { id: true } });
    // Simulates a pre-migration-shaped row: created with NONE of the 11 new
    // economic-treatment fields set. Proves the migration is purely additive
    // (no NOT NULL, no default requiring a backfill) — querying it must not
    // error, and every new field must read back null.
    const c = await db.charge.create({
      data: {
        organizationId: org.id, chargeNumber: `ETEST-NULL-${Date.now()}`, partyId: party.id,
        chargeType: "utility", status: "posted", dueDate: new Date(), amount: "1.00",
        currency: "MYR", outstandingAmount: "1.00",
      },
      select: {
        fundedBy: true, revenueRecognition: true, settlementRecipient: true, sourceSupplier: true,
        sourceInvoiceIssuedTo: true, actualCost: true, markupAmount: true, taxTreatment: true,
        taxRate: true, taxReason: true, taxDeterminedAt: true,
      },
    });
    expect(c).toEqual({
      fundedBy: null, revenueRecognition: null, settlementRecipient: null, sourceSupplier: null,
      sourceInvoiceIssuedTo: null, actualCost: null, markupAmount: null, taxTreatment: null,
      taxRate: null, taxReason: null, taxDeterminedAt: null,
    });
    await db.charge.deleteMany({ where: { chargeNumber: { startsWith: "ETEST-" } } });
  });

  it("round-trips non-null values across all 11 economic-treatment columns, including both Decimal columns and the DateTime column", async () => {
    const db = getDb();
    const org = await db.organization.findFirstOrThrow({ select: { id: true } });
    const party = await db.party.findFirstOrThrow({ where: { organizationId: org.id }, select: { id: true } });
    // Fixed UTC instant (not `new Date()`/Date.now()) so the assertion proves
    // exact round-trip, not just non-null. Every value is DISTINCT and typed
    // per its declared column so a migration-time column swap (e.g. actualCost
    // <-> markupAmount, both Decimal(12,2)) would be caught. Decimal inputs are
    // strings (never JS floats) to avoid float-precision drift, and none end in
    // a trailing zero, since Decimal-object .toFixed(2) is asserted, not a raw
    // DB string.
    const taxDeterminedAt = new Date("2026-07-19T12:34:56.000Z");
    const c = await db.charge.create({
      data: {
        organizationId: org.id, chargeNumber: `ETEST-ALL-${Date.now()}`, partyId: party.id,
        chargeType: "utility", status: "posted", dueDate: new Date(), amount: "1.00",
        currency: "MYR", outstandingAmount: "1.00",
        fundedBy: "owner", revenueRecognition: "owner_funds", settlementRecipient: "owner",
        sourceSupplier: "Air Selangor", sourceInvoiceIssuedTo: "tenant",
        actualCost: "123.45", markupAmount: "6.78",
        taxTreatment: "taxable_service", taxRate: "10.85", taxReason: "SST on service fee",
        taxDeterminedAt,
      },
      select: {
        fundedBy: true, revenueRecognition: true, settlementRecipient: true, sourceSupplier: true,
        sourceInvoiceIssuedTo: true, actualCost: true, markupAmount: true, taxTreatment: true,
        taxRate: true, taxReason: true, taxDeterminedAt: true,
      },
    });
    expect(c.fundedBy).toBe("owner");
    expect(c.revenueRecognition).toBe("owner_funds");
    expect(c.settlementRecipient).toBe("owner");
    expect(c.sourceSupplier).toBe("Air Selangor");
    expect(c.sourceInvoiceIssuedTo).toBe("tenant");
    expect(c.actualCost?.toFixed(2)).toBe("123.45");
    expect(c.markupAmount?.toFixed(2)).toBe("6.78");
    expect(c.taxTreatment).toBe("taxable_service");
    expect(c.taxRate?.toFixed(2)).toBe("10.85");
    expect(c.taxReason).toBe("SST on service fee");
    expect(c.taxDeterminedAt?.toISOString()).toBe(taxDeterminedAt.toISOString());
    await db.charge.deleteMany({ where: { chargeNumber: { startsWith: "ETEST-" } } });
  });
});
