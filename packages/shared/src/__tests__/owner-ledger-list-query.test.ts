// P4 Task 2: additive apartmentId filter on the entries list query.
import { describe, it, expect } from "vitest";
import { ownerLedgerListQuery } from "../schemas/owner-ledger";

describe("ownerLedgerListQuery — apartmentId (P4)", () => {
  it("accepts a uuid apartmentId and passes it through", () => {
    const parsed = ownerLedgerListQuery.safeParse({
      apartmentId: "f6000000-0000-4000-8000-0000000000a1",
      month: "2026-07",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.apartmentId).toBe("f6000000-0000-4000-8000-0000000000a1");
    }
  });

  it("rejects a non-uuid apartmentId", () => {
    const parsed = ownerLedgerListQuery.safeParse({ apartmentId: "apt-1" });
    expect(parsed.success).toBe(false);
  });

  it("stays optional — absent apartmentId parses as undefined", () => {
    const parsed = ownerLedgerListQuery.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.apartmentId).toBeUndefined();
  });
});
