// packages/shared/src/finance/__tests__/owner-net-payout.test.ts
import { describe, it, expect } from "vitest";
import { summarizeOwnerPeriod, summarizeTax, type OwnerLedgerLine } from "../owner-net-payout";

const L = (p: Partial<OwnerLedgerLine>): OwnerLedgerLine => ({
  direction: "expense", category: "other_expense", amount: "0.00", sstAmount: null,
  includeInPayout: true, taxCategory: "rental_expense", ...p,
});

describe("summarizeOwnerPeriod", () => {
  it("computes Net-Rental and Net-Payout where owner-paid expenses are excluded from payout", () => {
    const lines: OwnerLedgerLine[] = [
      L({ direction: "income", category: "rental_income", amount: "2500.00", includeInPayout: true }),
      L({ category: "maintenance_fee", amount: "350.00", includeInPayout: true }),       // KAEN
      L({ category: "management_fee", amount: "250.00", sstAmount: "20.00", includeInPayout: true }), // KAEN +SST
      L({ category: "repair_maintenance", amount: "180.00", includeInPayout: true }),     // KAEN
      L({ category: "assessment", amount: "320.00", includeInPayout: false }),            // OWNER-paid
    ];
    const s = summarizeOwnerPeriod(lines);
    expect(s.grossRental).toBe("2500.00");
    expect(s.totalExpenses).toBe("1120.00");          // 350+270+180+320  (mgmt incl. SST)
    expect(s.netRentalAfterExpenses).toBe("1380.00"); // 2500 - 1120
    expect(s.netPayoutToOwner).toBe("1700.00");       // 2500 - (350+270+180); assessment excluded
  });
});

describe("summarizeTax", () => {
  it("groups expense lines by taxCategory and by category", () => {
    const lines: OwnerLedgerLine[] = [
      L({ direction: "income", category: "rental_income", amount: "2500.00", taxCategory: "n/a" }),
      L({ category: "assessment", amount: "320.00", taxCategory: "govt_assessment", includeInPayout: false }),
      L({ category: "maintenance_fee", amount: "350.00", taxCategory: "service_charge" }),
      L({ category: "management_fee", amount: "250.00", sstAmount: "20.00", taxCategory: "service_charge" }),
    ];
    const t = summarizeTax(lines);
    // totalExpenses = 320 + 350 + 270 = 940.00
    expect(t.totalExpenses).toBe("940.00");
    // byTaxCategory
    expect(t.byTaxCategory["govt_assessment"]).toBe("320.00");
    expect(t.byTaxCategory["service_charge"]).toBe("620.00"); // 350 + 270
    // byCategory
    expect(t.byCategory["assessment"]).toBe("320.00");
    expect(t.byCategory["maintenance_fee"]).toBe("350.00");
    expect(t.byCategory["management_fee"]).toBe("270.00"); // 250 + 20 SST
  });
});
