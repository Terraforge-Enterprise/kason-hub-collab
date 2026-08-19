import { describe, it, expect } from "vitest";
import { classifyUtilityCharge, ClassificationError } from "../classify-utility";

describe("classifyUtilityCharge", () => {
  it("owner-funded electricity = owner disbursement", () => {
    expect(classifyUtilityCharge({ utility: "electricity", fundedBy: "owner", actualCost: 380, chargedAmount: 380 }))
      .toEqual({ revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 });
  });
  it("manager-advanced electricity = recovery of advance, NOT owner-credited", () => {
    const r = classifyUtilityCharge({ utility: "electricity", fundedBy: "manager", actualCost: 380, chargedAmount: 380 });
    expect(r.revenueRecognition).toBe("recovery_of_advance");
    expect(r.settlementRecipient).toBe("manager");
  });
  it("markup = manager revenue, pending SST review", () => {
    const r = classifyUtilityCharge({ utility: "electricity", fundedBy: "manager", actualCost: 380, chargedAmount: 420 });
    expect(r).toMatchObject({ revenueRecognition: "manager_revenue", taxTreatment: "pending_review", markupAmount: 40 });
  });
  it("cleaning as KAEN service = manager revenue, taxable", () => {
    const r = classifyUtilityCharge({ utility: "cleaning", fundedBy: "manager", actualCost: 30, chargedAmount: 30 });
    expect(r).toMatchObject({ revenueRecognition: "manager_revenue", taxTreatment: "taxable_service" });
  });
  it("throws on unknown combination", () => {
    // @ts-expect-error deliberate bad input
    expect(() => classifyUtilityCharge({ utility: "nonsense", fundedBy: "owner", actualCost: 1, chargedAmount: 1 })).toThrow(ClassificationError);
  });
  it("subsidy is always an owner-funded offset, regardless of fundedBy/markup-shaped amounts", () => {
    const r = classifyUtilityCharge({ utility: "subsidy", fundedBy: "manager", actualCost: 50, chargedAmount: 30 });
    expect(r).toEqual({ revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 });
  });
  it("tenant-direct funding of a pass-through utility at exact cost is nonsensical: throws PASSTHROUGH_FUNDING", () => {
    try {
      classifyUtilityCharge({ utility: "water", fundedBy: "tenant_direct", actualCost: 60, chargedAmount: 60 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ClassificationError);
      expect((e as ClassificationError).code).toBe("PASSTHROUGH_FUNDING");
    }
  });
  // Confirmatory/pinning tests below (adversarial-audit findings): the implementation already
  // produces these outputs (fixed by the brief), so these do not have a RED phase — they pin
  // already-correct-but-previously-untested behavior against future regressions.
  it("[pin] markup overrides tenant_direct on a pass-through utility — no throw, still manager_revenue", () => {
    const r = classifyUtilityCharge({ utility: "electricity", fundedBy: "tenant_direct", actualCost: 380, chargedAmount: 420 });
    expect(r).toMatchObject({ revenueRecognition: "manager_revenue", taxTreatment: "pending_review", markupAmount: 40 });
  });
  it("[pin] pass-through undercharge reports markupAmount 0 (negative markup is hardcoded away, not surfaced)", () => {
    const r = classifyUtilityCharge({ utility: "water", fundedBy: "owner", actualCost: 380, chargedAmount: 350 });
    expect(r).toEqual({ revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 });
  });
  it("[pin] service-utility (wifi) undercharge reports the raw negative markupAmount — asymmetric with pass-through above", () => {
    const r = classifyUtilityCharge({ utility: "wifi", fundedBy: "owner", actualCost: 50, chargedAmount: 40 });
    expect(r).toEqual({ revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: -10 });
  });

  // ── Task 3: optional `nature` re-routes tenant-borne SERVICE charges ──
  // "Tenant-funded" wifi/cleaning === fundedBy:"manager" (per fundedByForUtility:
  // wifiBearer/cleaningBearer === "tenant" ⇒ "manager"; the manager fronts the cost and
  // bills the tenant). tenant_direct service charges are never billed (dropped upstream).
  it("wifi tenant-funded with nature:'expense' = cost recovery (recovery_of_advance), NOT KAEN revenue", () => {
    const r = classifyUtilityCharge({ utility: "wifi", fundedBy: "manager", actualCost: 50, chargedAmount: 50, nature: "expense" });
    expect(r.revenueRecognition).toBe("recovery_of_advance");
    expect(r.taxTreatment).toBe("out_of_scope_disbursement");
    expect(r).toEqual({ revenueRecognition: "recovery_of_advance", settlementRecipient: "manager", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 });
  });
  it("wifi tenant-funded with nature omitted = manager revenue, taxable (unchanged)", () => {
    const r = classifyUtilityCharge({ utility: "wifi", fundedBy: "manager", actualCost: 50, chargedAmount: 50 });
    expect(r.revenueRecognition).toBe("manager_revenue");
    expect(r).toMatchObject({ revenueRecognition: "manager_revenue", settlementRecipient: "manager", taxTreatment: "taxable_service" });
  });
  // ── maintenance (69fc262f made it billable; it reached this classifier unbucketed and
  // threw UNKNOWN_UTILITY at Bill time). These pin it to the SERVICE bucket, mirroring
  // cleaning/wifi — which is what the seeded categories and fundedByForUtility already
  // assume. They are confirmatory of the bucket DECISION rather than of the throw itself
  // (the throw is pinned at the mint seam in itemized-mint.test.ts, which had the RED).
  it("owner-borne maintenance = owner disbursement, never a ClassificationError", () => {
    const r = classifyUtilityCharge({ utility: "maintenance", fundedBy: "owner", actualCost: 300, chargedAmount: 300 });
    expect(r).toEqual({ revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 });
  });
  it("tenant-borne maintenance = manager revenue, taxable — identical to cleaning", () => {
    const r = classifyUtilityCharge({ utility: "maintenance", fundedBy: "manager", actualCost: 80, chargedAmount: 80 });
    const cleaning = classifyUtilityCharge({ utility: "cleaning", fundedBy: "manager", actualCost: 80, chargedAmount: 80 });
    expect(r).toMatchObject({ revenueRecognition: "manager_revenue", settlementRecipient: "manager", taxTreatment: "taxable_service" });
    expect(r).toEqual(cleaning);
  });
  it("tenant-borne maintenance with nature:'expense' = cost recovery, not KAEN revenue", () => {
    const r = classifyUtilityCharge({ utility: "maintenance", fundedBy: "manager", actualCost: 80, chargedAmount: 80, nature: "expense" });
    expect(r).toEqual({ revenueRecognition: "recovery_of_advance", settlementRecipient: "manager", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 });
  });

  it("wifi with nature:'expense' but owner-funded stays owner_funds — owner side unaffected by tenant expense mapping", () => {
    const r = classifyUtilityCharge({ utility: "wifi", fundedBy: "owner", actualCost: 50, chargedAmount: 50, nature: "expense" });
    expect(r.revenueRecognition).toBe("owner_funds");
    expect(r).toMatchObject({ revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement" });
  });
});
