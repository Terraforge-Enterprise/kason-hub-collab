// Task 4 (bills-grid grid funded-by capture): fundedByForUtility derives the
// FundedBy a grid entry implies for ONE utility. PURE, no-I/O — Default suite,
// NO DB (mirrors classify-utility.test.ts / row-dto-mappers.test.ts).
import { describe, it, expect } from "vitest";
import { fundedByForUtility } from "../service";

// "Neutral" baseline: every field set to a value that maps to "owner" if read,
// so each test overrides ONLY the field(s) under test. Distractor tests below
// deliberately diverge fields to prove per-utility field isolation.
const BASE = { tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" };

describe("fundedByForUtility", () => {
  describe("electricity (reads tnbPattern)", () => {
    it("manager_advanced tnbPattern -> manager", () => {
      // airPattern deliberately set to "tenant_direct" (differs from tnbPattern):
      // if the implementation wrongly read airPattern for electricity, this would
      // return "tenant_direct" instead of "manager".
      const entry = { ...BASE, tnbPattern: "manager_advanced", airPattern: "tenant_direct" };
      expect(fundedByForUtility(entry, "electricity")).toBe("manager");
    });

    it("tenant_direct tnbPattern -> tenant_direct", () => {
      const entry = { ...BASE, tnbPattern: "tenant_direct" };
      expect(fundedByForUtility(entry, "electricity")).toBe("tenant_direct");
    });

    it("absorbed tnbPattern -> owner", () => {
      const entry = { ...BASE, tnbPattern: "absorbed" };
      expect(fundedByForUtility(entry, "electricity")).toBe("owner");
    });

    it("recharged tnbPattern -> owner", () => {
      const entry = { ...BASE, tnbPattern: "recharged" };
      expect(fundedByForUtility(entry, "electricity")).toBe("owner");
    });
  });

  describe("water (reads airPattern, NOT tnbPattern)", () => {
    it("manager_advanced airPattern -> manager, ignoring a differing tnbPattern (field isolation)", () => {
      // tnbPattern deliberately set to "tenant_direct" (differs from airPattern):
      // if the implementation wrongly read tnbPattern for water, this would
      // return "tenant_direct" instead of "manager".
      const entry = { ...BASE, tnbPattern: "tenant_direct", airPattern: "manager_advanced" };
      expect(fundedByForUtility(entry, "water")).toBe("manager");
    });

    it("tenant_direct airPattern -> tenant_direct", () => {
      const entry = { ...BASE, airPattern: "tenant_direct" };
      expect(fundedByForUtility(entry, "water")).toBe("tenant_direct");
    });

    it("absorbed airPattern -> owner", () => {
      const entry = { ...BASE, airPattern: "absorbed" };
      expect(fundedByForUtility(entry, "water")).toBe("owner");
    });

    it("recharged airPattern -> owner", () => {
      const entry = { ...BASE, airPattern: "recharged" };
      expect(fundedByForUtility(entry, "water")).toBe("owner");
    });
  });

  describe("sewerage (Indah Water — hardcoded owner, no grid column)", () => {
    it("is always owner, ignoring every entry field", () => {
      // Distractor: every field set to a NON-owner-implying value. If sewerage
      // wrongly fell through to reading some entry field, this would return
      // "manager" or "tenant_direct" instead of "owner".
      const distractor = { tnbPattern: "manager_advanced", airPattern: "manager_advanced", cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "tenant" };
      expect(fundedByForUtility(distractor, "sewerage")).toBe("owner");
    });
  });

  describe("cleaning (reads cleaningBearer)", () => {
    it("tenant cleaningBearer -> manager", () => {
      const entry = { ...BASE, cleaningBearer: "tenant" };
      expect(fundedByForUtility(entry, "cleaning")).toBe("manager");
    });

    it("owner cleaningBearer -> owner", () => {
      const entry = { ...BASE, cleaningBearer: "owner" };
      expect(fundedByForUtility(entry, "cleaning")).toBe("owner");
    });

    // [pin] symmetric to wifi's "not reusing cleaningBearer" test above — proves
    // the reverse direction (cleaning not reusing wifiBearer). Passes without a
    // further implementation change (cleaning's branch never reads wifiBearer).
    it("[pin] tenant cleaningBearer -> manager, ignoring a differing wifiBearer (not reusing wifi's bearer)", () => {
      const entry = { ...BASE, cleaningBearer: "tenant", wifiBearer: "owner" };
      expect(fundedByForUtility(entry, "cleaning")).toBe("manager");
    });
  });

  describe("wifi (reads wifiBearer)", () => {
    it("tenant wifiBearer -> manager, ignoring a differing cleaningBearer (not reusing cleaning's bearer)", () => {
      // cleaningBearer deliberately "owner" (opposite of wifiBearer): if the
      // implementation wrongly read cleaningBearer for wifi (copy-paste bug),
      // this would return "owner" instead of "manager".
      const entry = { ...BASE, cleaningBearer: "owner", wifiBearer: "tenant" };
      expect(fundedByForUtility(entry, "wifi")).toBe("manager");
    });

    // [pin] wifi's ternary was implemented in one shot alongside the "tenant"
    // cycle above (mirroring cleaning's shape) — this passes without a further
    // implementation change; pinning it against regression per classify-utility.test.ts precedent.
    it("[pin] owner wifiBearer -> owner", () => {
      const entry = { ...BASE, wifiBearer: "owner" };
      expect(fundedByForUtility(entry, "wifi")).toBe("owner");
    });
  });

  describe("subsidy (always an owner-funded offset)", () => {
    it("is always owner, ignoring every entry field", () => {
      const distractor = { tnbPattern: "manager_advanced", airPattern: "manager_advanced", cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "tenant" };
      expect(fundedByForUtility(distractor, "subsidy")).toBe("owner");
    });
  });

  // Note: added alongside the implementation (not strictly test-first — see the
  // task-4 report's self-review) rather than as its own RED/GREEN cycle; the
  // report's sabotage spot-check specifically re-validates this behavior
  // FAIL->PASS to close that gap.
  describe("defense-in-depth: an unrecognized pattern value throws rather than silently defaulting", () => {
    it("an unrecognized tnbPattern for electricity throws (mirrors classify-utility.ts's UNKNOWN_UTILITY precedent)", () => {
      // Only reachable if a value outside the zod utilityPattern enum reaches
      // this pure function (e.g. legacy data) — the zod schema is the real gate.
      const entry = { ...BASE, tnbPattern: "bogus_pattern" };
      expect(() => fundedByForUtility(entry, "electricity")).toThrow();
    });
  });
});
