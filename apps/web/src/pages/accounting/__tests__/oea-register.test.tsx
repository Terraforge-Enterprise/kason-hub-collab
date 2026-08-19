import { describe, expect, it } from "vitest";
import { statusMeta } from "../document-helpers";

/**
 * OEA badge in the accounting register (R5).
 *
 * An Owner Expense Advice records money already deducted from the owner's payout, so it
 * has no payment axis. Showing it as "Unpaid" would imply the owner still owes it.
 */
describe("OEA in the accounting register", () => {
  it("badges an issued OEA as Deducted, never as a payment status", () => {
    const badges = statusMeta({
      docType: "owner_expense_advice",
      documentStatus: "ISSUED",
      settlementStatus: "UNPAID",
    } as never);
    expect(badges.primary.label).toBe("Deducted");
  });

  it("lets lifecycle win over the Deducted badge when the OEA is cancelled", () => {
    const badges = statusMeta({
      docType: "owner_expense_advice",
      documentStatus: "CANCELLED",
      settlementStatus: "UNPAID",
    } as never);
    expect(badges.primary.label).toBe("Voided");
  });

  it("shows the re-Billed wording when a cancelled OEA was superseded", () => {
    const badges = statusMeta({
      docType: "owner_expense_advice",
      documentStatus: "CANCELLED",
      settlementStatus: "UNPAID",
      isReBilled: true,
    } as never);
    expect(badges.primary.label).toBe("Voided · Re-Billed");
  });

  it("leaves an ordinary invoice on its payment axis (the OEA branch must not over-match)", () => {
    const badges = statusMeta({
      docType: "invoice",
      documentStatus: "ISSUED",
      settlementStatus: "UNPAID",
    } as never);
    expect(badges.primary.label).not.toBe("Deducted");
  });
});
