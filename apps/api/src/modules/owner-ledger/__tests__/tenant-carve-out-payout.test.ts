// tenant-carve-out-payout.test.ts
//
// Source 4 books the tenant's utility/aircond carve-out as owner INCOME. Under the
// gross model that is only sound when Source 3 also books the FULL supplier bill as
// an owner EXPENSE, so the pair nets to the owner's real share. Source 3 needs a
// CHARGED UnitUtilityBill; the bills-grid path never writes one, so on that path the
// income half stood alone and the owner was credited the tenant's entire utility
// bill.
//
// These tests pin the pairing rule itself — the only thing standing between "the
// owner is over-paid by every utility the tenant pays" and "the meter path silently
// under-pays because its offsetting income vanished".
import { describe, it, expect } from "vitest";
import { tenantCarveOutIncludeInPayout, gridProviderBillDeducts } from "../owner-ledger.sync";

describe("tenantCarveOutIncludeInPayout", () => {
  it("neutralises an UNPAIRED carve-out on a whole unit (the reported bug)", () => {
    // Grid path: charges exist, no UnitUtilityBill can exist, so no expense offsets
    // them. Income must not move the payout.
    expect(
      tenantCarveOutIncludeInPayout({ listingMode: "WHOLE", apartmentHasGrossUtilityExpense: false }),
    ).toBe(false);
  });

  it("keeps a PAIRED carve-out in the payout on a whole unit", () => {
    // Meter path: the full supplier bill is booked as an expense for this apartment,
    // so removing the income half would deduct the whole bill from the owner.
    expect(
      tenantCarveOutIncludeInPayout({ listingMode: "WHOLE", apartmentHasGrossUtilityExpense: true }),
    ).toBe(true);
  });

  // Partitioned units are explicitly out of scope: their split maths (per-pax
  // pooling, subsidy, private aircond) is a separate design the user has not
  // signed off. Behaviour there must stay byte-identical to today.
  it("leaves PARTITIONED units unchanged, paired or not", () => {
    expect(
      tenantCarveOutIncludeInPayout({ listingMode: "PARTITIONED", apartmentHasGrossUtilityExpense: false }),
    ).toBe(true);
    expect(
      tenantCarveOutIncludeInPayout({ listingMode: "PARTITIONED", apartmentHasGrossUtilityExpense: true }),
    ).toBe(true);
  });

  // A charge whose listing/apartment could not be resolved carries no mode. Falling
  // back to the old behaviour keeps an unresolvable row from silently changing the
  // owner's money in either direction.
  it("falls back to the existing behaviour when the listing mode is unknown", () => {
    expect(
      tenantCarveOutIncludeInPayout({ listingMode: null, apartmentHasGrossUtilityExpense: false }),
    ).toBe(true);
  });
});

// The other half of the same question, for PARTITIONED units: their tenant carve-out
// STAYS payout income (above), so the provider bill must be booked against it or the
// owner keeps the tenants' utility money instead of just the meter spread.
describe("gridProviderBillDeducts", () => {
  const base = { listingMode: "PARTITIONED", billed: true, pattern: "recharged", rawAmount: 300 };

  it("deducts a KAEN-fronted recharged bill on a partitioned unit", () => {
    expect(gridProviderBillDeducts(base)).toBe(true);
    expect(gridProviderBillDeducts({ ...base, pattern: "manager_advanced" })).toBe(true);
  });

  // bills-grid already mints a GRIDOWN- charge billed TO the owner for an absorbed
  // utility. Deducting it here as well charges them twice for one supply.
  it("never deducts an owner-ABSORBED bill — the owner is invoiced for it separately", () => {
    expect(gridProviderBillDeducts({ ...base, pattern: "absorbed" })).toBe(false);
  });

  it("never deducts a tenant-direct bill — no KAEN money moves", () => {
    expect(gridProviderBillDeducts({ ...base, pattern: "tenant_direct" })).toBe(false);
  });

  // Before Bill there are no tenant charges to pair against, so deducting would show
  // the owner carrying the entire master bill on their own.
  it("waits for the entry to be billed", () => {
    expect(gridProviderBillDeducts({ ...base, billed: false })).toBe(false);
  });

  // WHOLE units are pass-through on both sides — their carve-out income is already
  // neutralised, so adding an expense here would DEDUCT a bill the tenant paid.
  it("never touches a WHOLE unit — that would deduct a bill the tenant already paid", () => {
    expect(gridProviderBillDeducts({ ...base, listingMode: "WHOLE" })).toBe(false);
    expect(gridProviderBillDeducts({ ...base, listingMode: null })).toBe(false);
  });

  it("ignores an absent or non-positive raw bill", () => {
    expect(gridProviderBillDeducts({ ...base, rawAmount: null })).toBe(false);
    expect(gridProviderBillDeducts({ ...base, rawAmount: 0 })).toBe(false);
  });
});
