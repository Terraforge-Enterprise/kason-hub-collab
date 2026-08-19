/**
 * Task 4 (bill-expenses-as-invoice-line-items, R2): per-charge `sstRate`
 * override resolution used by both line builders
 * (bills-grid/issue-grouped.ts's group line map and
 * billing-documents/issue.service.ts's buildLinesForCharge).
 *
 * `resolveLineSst` is the single pure helper both builders call: the
 * per-charge override wins when present, else the routing category's
 * default. A null override (every existing charge today, since Task 1 added
 * the column as nullable-with-no-writer yet) MUST fall back to the category
 * default — i.e. produce byte-identical output to the pre-Task-4 code path.
 *
 * Run:
 *   npx vitest run apps/api/src/modules/bills-grid/__tests__/sst-override.test.ts
 */
import { describe, it, expect } from "vitest";

// Pure helper extracted from the line map (Step 3 introduces `resolveLineSst`).
import { resolveLineSst } from "../issue-grouped";

describe("resolveLineSst", () => {
  it("override wins over category default", () => {
    expect(resolveLineSst("8", "0")).toBe("8");
  });
  it("null falls back to category default", () => {
    expect(resolveLineSst(null, "6")).toBe("6");
  });
});
