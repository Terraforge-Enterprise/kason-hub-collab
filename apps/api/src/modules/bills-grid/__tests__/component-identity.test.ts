// A grid component's identity — the key a partial re-Bill uses to say "this line is
// already paid, do not re-mint it".
//
// Getting this wrong is a money bug in both directions: too broad and the tenant is
// under-billed for a line nobody paid; too narrow and a paid line is re-billed.
import { describe, expect, it } from "vitest";
import { componentIdentity } from "../service";

describe("componentIdentity", () => {
  it("strips the revision suffix so an identity survives re-Bills", () => {
    expect(componentIdentity("GRIDUTIL-202608-room-a-ELECTRICITY-r3")).toBe("GRIDUTIL-202608-room-a-ELECTRICITY");
    expect(componentIdentity("GRIDUTIL-202608-room-a-ELECTRICITY")).toBe("GRIDUTIL-202608-room-a-ELECTRICITY");
  });

  it("handles a multi-digit revision", () => {
    expect(componentIdentity("GRIDAC-202608-room-a-r12")).toBe("GRIDAC-202608-room-a");
  });

  it("does NOT collide a room's submeter electricity with its shared electricity", () => {
    // THE reason the key is the charge number and not (unitId, categoryId): both of these
    // mint under cats.electricity.tenantCategoryId with the SAME unitId, so a category-keyed
    // skip set would withhold whichever it matched first.
    const submeter = componentIdentity("GRIDAC-202608-room-a-r1");
    const shared = componentIdentity("GRIDUTIL-202608-room-a-ELECTRICITY-r1");
    expect(submeter).not.toBe(shared);
  });

  it("keeps an expense line distinct from its SST sibling", () => {
    // They must stay separable: paying the base does not pay the tax. Slice 2 treats an
    // expense as paid only when BOTH are, but the identities themselves stay distinct.
    expect(componentIdentity("GRIDEXP-202608-exp1-r2")).toBe("GRIDEXP-202608-exp1");
    expect(componentIdentity("GRIDEXP-202608-exp1-SST-r2")).toBe("GRIDEXP-202608-exp1-SST");
  });

  it("never truncates a `-r` that appears INSIDE an id", () => {
    // The regex is end-anchored. A uuid segment ending in "-r" followed by more text, or a
    // literal "-r" mid-string, must survive — otherwise two unrelated components collapse
    // onto one identity and a paid line silently suppresses an unpaid one.
    expect(componentIdentity("GRIDEXP-202608-r-abc")).toBe("GRIDEXP-202608-r-abc");
    expect(componentIdentity("GRIDRECUR-202608-def-r9-abc")).toBe("GRIDRECUR-202608-def-r9-abc");
  });

  it("strips only the LAST revision suffix, not a repeated one", () => {
    // Defensive: charge numbers are built by appending one suffix, so this shape should not
    // occur — pinned so a future double-append is visible rather than silently half-stripped.
    expect(componentIdentity("GRIDUTIL-202608-x-WIFI-r1-r2")).toBe("GRIDUTIL-202608-x-WIFI-r1");
  });

  it("is idempotent", () => {
    const once = componentIdentity("GRIDOWN-202608-apt-WIFI-r4");
    expect(componentIdentity(once)).toBe(once);
  });
});
