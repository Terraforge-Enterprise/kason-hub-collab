import { describe, it, expect } from "vitest";
import { generateStatementInput } from "../owner-billing";

// generateStatementInput has TWO shapes, distinguished by `apartmentId`:
//   • absent  ⇒ the combined "All Units" statement (one owner_statement Invoice
//     per owner/month, apartmentId null).
//   • present (a valid uuid) ⇒ a per-unit statement scoped to that apartment
//     (per-unit generation re-enabled — see #86). The body is still `.strict()`,
//     so any OTHER unknown key is rejected.
describe("generateStatementInput — combined + per-unit (optional apartmentId)", () => {
  it("accepts a bare { ownerPartyId, billingMonth } body", () => {
    const r = generateStatementInput.safeParse({
      ownerPartyId: "11111111-1111-4111-8111-111111111111",
      billingMonth: "2026-06",
    });
    expect(r.success).toBe(true);
  });

  it("ACCEPTS an optional apartmentId (per-unit generation re-enabled)", () => {
    const r = generateStatementInput.safeParse({
      ownerPartyId: "11111111-1111-4111-8111-111111111111",
      billingMonth: "2026-06",
      apartmentId: "22222222-2222-4222-8222-222222222222",
    });
    expect(r.success).toBe(true);
  });

  it("REJECTS any unknown key (strict schema)", () => {
    const r = generateStatementInput.safeParse({
      ownerPartyId: "11111111-1111-4111-8111-111111111111",
      billingMonth: "2026-06",
      somethingElse: true,
    });
    expect(r.success).toBe(false);
  });
});
