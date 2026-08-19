// Owner-Billing (M6) — shared Zod input contract + constant sets.
// Plan: docs/superpowers/plans/2026-06-11-phase2-owner-billing.md (Task A1).
//
// Rules under test:
//   - a valid `percent` fee config parses
//   - feeType="cap" WITHOUT capAmount fails the .refine (path ["capAmount"])
//   - FEE_TYPES deep-equals ["percent","fixed","cap"] (consumers index on order)
//   - an unknown feeType is rejected by the enum
//   - NEGATIVE money/percent inputs are rejected: every value these schemas guard
//     (feeValue, capAmount, sstPercent, statement-line amount,
//     cleaning-bill amount) is >= 0 by domain. A signed total only exists on the
//     computed net-remittance (B2/B3), which does NOT flow through these validators.
//
// NOTE on the UUID fixture: Zod v4's `.uuid()` enforces the RFC v4 bit pattern
// (third group starts "4", fourth starts "8"-"b"), so the plan's illustrative
// "11111111-..." string is NOT a valid v4 UUID and would fail the schema for the
// WRONG reason. We use the codebase's canonical valid-v4 fixture instead so the
// positive case exercises the fee-config branch, not UUID validation.

import { describe, it, expect } from "vitest";
import {
  managementFeeConfigInput,
  managementFeeConfigPatch,
  generateStatementInput,
  statementLineInput,
  statementLinePatch,
  FEE_TYPES,
  OWNER_STATEMENT_TYPE,
  OWNER_CHARGE_TYPES,
} from "./owner-billing";

// Valid UUIDv4 (Zod v4's .uuid() enforces the v4 bit pattern).
const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000002";

describe("FEE_TYPES / OWNER_CHARGE_TYPES constants", () => {
  it("FEE_TYPES deep-equals the ordered tuple consumers index on", () => {
    expect(FEE_TYPES).toEqual(["percent", "fixed", "cap"]);
  });

  it("OWNER_STATEMENT_TYPE is the owner_statement invoice discriminator", () => {
    expect(OWNER_STATEMENT_TYPE).toBe("owner_statement");
  });

  it("OWNER_CHARGE_TYPES carries the full owner-statement line catalog", () => {
    expect(OWNER_CHARGE_TYPES).toEqual([
      "management_fee",
      "cleaning",
      "tnb",
      "water",
      "wifi",
      "maintenance",
      "insurance",
      "assessment_tax",
      "sewerage",
      "cukai_petak",
      "access_card",
      "other",
    ]);
  });
});

describe("managementFeeConfigInput", () => {
  it("accepts a valid percent config (sstPercent supplied)", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "percent",
      feeValue: "10",
      sstPercent: "8",
    });
    expect(r.success).toBe(true);
  });

  it("defaults sstPercent to '8' and isActive to true when omitted", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "fixed",
      feeValue: "250",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sstPercent).toBe("8");
      expect(r.data.isActive).toBe(true);
    }
  });

  it("accepts an optional propertyId scoped config", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      propertyId: PROPERTY_ID,
      feeType: "percent",
      feeValue: "7.5",
    });
    expect(r.success).toBe(true);
  });

  it("requires capAmount when feeType=cap (error path is ['capAmount'])", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "cap",
      feeValue: "10",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === "capAmount")).toBe(true);
    }
  });

  it("accepts a cap config when capAmount is provided", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "cap",
      feeValue: "10",
      capAmount: "250",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown feeType", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "bogus",
      feeValue: "1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-uuid ownerPartyId", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: "not-a-uuid",
      feeType: "percent",
      feeValue: "1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a money value with more than 2 decimal places", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "percent",
      feeValue: "10.123",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a negative feeValue (fees are >= 0 by domain)", () => {
    const r = managementFeeConfigInput.safeParse({
      ownerPartyId: OWNER_ID,
      feeType: "percent",
      feeValue: "-50",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a negative capAmount and sstPercent", () => {
    expect(
      managementFeeConfigInput.safeParse({
        ownerPartyId: OWNER_ID,
        feeType: "cap",
        feeValue: "10",
        capAmount: "-250",
      }).success,
    ).toBe(false);
    expect(
      managementFeeConfigInput.safeParse({
        ownerPartyId: OWNER_ID,
        feeType: "percent",
        feeValue: "10",
        sstPercent: "-8",
      }).success,
    ).toBe(false);
  });
});

describe("managementFeeConfigPatch", () => {
  it("makes every config field optional but requires expectedUpdatedAt", () => {
    const ok = managementFeeConfigPatch.safeParse({
      feeValue: "12",
      expectedUpdatedAt: "2026-06-15T00:00:00Z",
    });
    expect(ok.success).toBe(true);

    const missingConcurrency = managementFeeConfigPatch.safeParse({ feeValue: "12" });
    expect(missingConcurrency.success).toBe(false);
  });
});

describe("generateStatementInput", () => {
  it("accepts a YYYY-MM billingMonth", () => {
    const r = generateStatementInput.safeParse({
      ownerPartyId: OWNER_ID,
      billingMonth: "2026-06",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed billingMonth", () => {
    expect(
      generateStatementInput.safeParse({ ownerPartyId: OWNER_ID, billingMonth: "2026-6" }).success,
    ).toBe(false);
    expect(
      generateStatementInput.safeParse({ ownerPartyId: OWNER_ID, billingMonth: "06-2026" }).success,
    ).toBe(false);
  });
});

describe("statementLineInput / statementLinePatch", () => {
  it("accepts a valid charge line", () => {
    const r = statementLineInput.safeParse({
      chargeType: "tnb",
      description: "TNB electricity June",
      amount: "200.00",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an empty description and an over-length one", () => {
    expect(
      statementLineInput.safeParse({ chargeType: "tnb", description: "", amount: "1" }).success,
    ).toBe(false);
    expect(
      statementLineInput.safeParse({
        chargeType: "tnb",
        description: "x".repeat(201),
        amount: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown chargeType", () => {
    expect(
      statementLineInput.safeParse({ chargeType: "bribe", description: "x", amount: "1" }).success,
    ).toBe(false);
  });

  it("rejects a negative statement-line amount (admin expense lines are >= 0)", () => {
    expect(
      statementLineInput.safeParse({ chargeType: "tnb", description: "x", amount: "-1.00" })
        .success,
    ).toBe(false);
  });

  it("statementLinePatch requires expectedUpdatedAt + at least one mutable field", () => {
    // A no-op patch (only the concurrency token) is rejected — it would bump
    // Charge.updatedAt and write an empty-diff audit row for no real change.
    expect(
      statementLinePatch.safeParse({ expectedUpdatedAt: "2026-06-15T00:00:00Z" }).success,
    ).toBe(false);
    // Missing expectedUpdatedAt is still rejected.
    expect(statementLinePatch.safeParse({ amount: "5.00" }).success).toBe(false);
    // amount-only or description-only (with the token) are accepted.
    expect(
      statementLinePatch.safeParse({ amount: "5.00", expectedUpdatedAt: "2026-06-15T00:00:00Z" })
        .success,
    ).toBe(true);
    expect(
      statementLinePatch.safeParse({ description: "Water", expectedUpdatedAt: "2026-06-15T00:00:00Z" })
        .success,
    ).toBe(true);
  });
});

// The `cleaningBillInput` describe block was REMOVED 2026-08-17 with the schema itself,
// the manual cleaning-bill endpoints and the owner-settings cleaningAutoBill field.
