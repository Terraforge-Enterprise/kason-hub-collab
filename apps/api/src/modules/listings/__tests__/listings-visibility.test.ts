import { describe, it, expect } from "vitest";
import { canAgentSeeUnit, type UnitVisibilityFields } from "../listings-visibility";

const base: UnitVisibilityFields = {
  id: "u1",
  visibilityMode: "PUBLIC",
  hiddenFromPartyIds: [],
  sourcingAgentId: null,
  inChargePartyId: null,
};

describe("canAgentSeeUnit", () => {
  it("public + no hide list: all agents see", () => {
    expect(canAgentSeeUnit(base, "agent-1")).toBe(true);
  });
  it("public + hidden-from agent-1: agent-1 hidden", () => {
    expect(canAgentSeeUnit({ ...base, hiddenFromPartyIds: ["agent-1"] }, "agent-1")).toBe(false);
    expect(canAgentSeeUnit({ ...base, hiddenFromPartyIds: ["agent-1"] }, "agent-2")).toBe(true);
  });
  it("restricted + no grant: hidden", () => {
    expect(canAgentSeeUnit({ ...base, visibilityMode: "RESTRICTED" }, "agent-1")).toBe(false);
  });
  it("restricted + grant present: visible", () => {
    expect(canAgentSeeUnit({ ...base, visibilityMode: "RESTRICTED" }, "agent-1", ["agent-1"])).toBe(true);
  });
  it("agent-sourced: visible (every Listing is approved post-refactor)", () => {
    // Pre-refactor a "sourceFlag=AGENT_SOURCED + sourcingApproved=false" Listing
    // was visible only to the sourcing agent. Post-refactor that state lives in
    // UnitSubmission, not Listing — every Listing row is approved.
    const u: UnitVisibilityFields = { ...base, sourcingAgentId: "agent-1" };
    expect(canAgentSeeUnit(u, "agent-1")).toBe(true);
    expect(canAgentSeeUnit(u, "agent-2")).toBe(true);
  });
  it("in-charge agent sees the unit even when RESTRICTED with no grant", () => {
    const u: UnitVisibilityFields = {
      ...base,
      visibilityMode: "RESTRICTED",
      inChargePartyId: "agent-1",
    };
    expect(canAgentSeeUnit(u, "agent-1")).toBe(true);
    // Other agents still gated by RESTRICTED — no grant → hidden.
    expect(canAgentSeeUnit(u, "agent-2")).toBe(false);
  });
  it("in-charge agent sees the unit even when on hiddenFromPartyIds", () => {
    const u: UnitVisibilityFields = {
      ...base,
      hiddenFromPartyIds: ["agent-1"],
      inChargePartyId: "agent-1",
    };
    expect(canAgentSeeUnit(u, "agent-1")).toBe(true);
  });
});
