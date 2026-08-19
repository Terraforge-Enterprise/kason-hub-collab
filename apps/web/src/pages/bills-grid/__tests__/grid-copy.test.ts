// Excel-Web V2 — Copy planner. Pure unit tests over a hand-built nav grid.
import { describe, it, expect } from "vitest";
import { planRectangularCopy, matrixToTsv, countCells } from "../grid-copy";
import type { NavRow, NavCell } from "../nav-cells";
import type { ColumnId } from "../columns";

const dataColumns = [{ id: "cleaningOwner" }, { id: "tnbOwner" }, { id: "maintenanceFee" }];

function nc(cellKey: string, columnId: ColumnId, rowIndex: number): NavCell {
  return { cellKey, columnId, apartmentId: cellKey, rowType: "unit", rowIndex, editable: true };
}

// A 2-row × 3-col grid; each unit row's cells all share the row's cellKey.
function fullGrid(): NavRow[] {
  return [
    { key: "A", apartmentId: "A", rowType: "unit", cells: [nc("A", "cleaningOwner", 0), nc("A", "tnbOwner", 0), nc("A", "maintenanceFee", 0)] },
    { key: "B", apartmentId: "B", rowType: "unit", cells: [nc("B", "cleaningOwner", 1), nc("B", "tnbOwner", 1), nc("B", "maintenanceFee", 1)] },
  ];
}

const sel = (cellKey: string, columnId: ColumnId) => ({ cellKey, columnId });

describe("grid-copy — planRectangularCopy", () => {
  it("empty selection → status 'empty'", () => {
    expect(planRectangularCopy(fullGrid(), dataColumns, [])).toEqual({ status: "empty" });
  });

  it("a single contiguous 2×2 rectangle → status 'ok' with a 2×2 matrix", () => {
    const plan = planRectangularCopy(fullGrid(), dataColumns, [
      sel("A", "cleaningOwner"),
      sel("A", "tnbOwner"),
      sel("B", "cleaningOwner"),
      sel("B", "tnbOwner"),
    ]);
    expect(plan.status).toBe("ok");
    expect(plan.matrix).toHaveLength(2);
    expect(plan.matrix![0].map((c) => c?.columnId)).toEqual(["cleaningOwner", "tnbOwner"]);
    expect(plan.matrix![1].map((c) => c?.cellKey)).toEqual(["B", "B"]);
  });

  it("a single row range → 'ok' with a 1×3 matrix", () => {
    const plan = planRectangularCopy(fullGrid(), dataColumns, [
      sel("A", "cleaningOwner"),
      sel("A", "tnbOwner"),
      sel("A", "maintenanceFee"),
    ]);
    expect(plan.status).toBe("ok");
    expect(plan.matrix).toHaveLength(1);
    expect(plan.matrix![0]).toHaveLength(3);
  });

  it("a non-contiguous selection (a navigable cell inside the bbox is unselected) → 'noncontiguous'", () => {
    // Diagonal A:cleaningOwner + B:tnbOwner — the bbox is the 2×2 block, but
    // A:tnbOwner and B:cleaningOwner are navigable-and-unselected → refuse.
    const plan = planRectangularCopy(fullGrid(), dataColumns, [sel("A", "cleaningOwner"), sel("B", "tnbOwner")]);
    expect(plan.status).toBe("noncontiguous");
    expect(plan.matrix).toBeUndefined();
  });

  it("a structural blank inside the rectangle is NOT a hole — it becomes a null cell, status stays 'ok'", () => {
    // Row B is missing tnbOwner entirely (a rendered-but-non-navigable blank).
    const grid: NavRow[] = [
      { key: "A", apartmentId: "A", rowType: "unit", cells: [nc("A", "cleaningOwner", 0), nc("A", "tnbOwner", 0), nc("A", "maintenanceFee", 0)] },
      { key: "B", apartmentId: "B", rowType: "unit", cells: [nc("B", "cleaningOwner", 1), nc("B", "maintenanceFee", 1)] },
    ];
    // Select every NAVIGABLE cell in the 2×3 block (B:tnbOwner doesn't exist).
    const plan = planRectangularCopy(grid, dataColumns, [
      sel("A", "cleaningOwner"),
      sel("A", "tnbOwner"),
      sel("A", "maintenanceFee"),
      sel("B", "cleaningOwner"),
      sel("B", "maintenanceFee"),
    ]);
    expect(plan.status).toBe("ok");
    expect(plan.matrix![1][1]).toBeNull(); // the structural blank at B×tnbOwner
    expect(plan.matrix![1][0]?.cellKey).toBe("B");
  });
});

describe("grid-copy — matrixToTsv + countCells", () => {
  it("serialises row-major with tabs/newlines; structural blanks are empty fields", () => {
    const plan = planRectangularCopy(fullGrid(), dataColumns, [
      sel("A", "cleaningOwner"),
      sel("A", "tnbOwner"),
      sel("B", "cleaningOwner"),
      sel("B", "tnbOwner"),
    ]);
    const tsv = matrixToTsv(plan.matrix!, (c) => `${c.cellKey}:${c.columnId}`);
    expect(tsv).toBe("A:cleaningOwner\tA:tnbOwner\nB:cleaningOwner\tB:tnbOwner");
  });

  it("a matrix with a null cell emits an empty TSV field to keep columns aligned", () => {
    const grid: NavRow[] = [
      { key: "A", apartmentId: "A", rowType: "unit", cells: [nc("A", "cleaningOwner", 0), nc("A", "maintenanceFee", 0)] },
    ];
    const plan = planRectangularCopy(grid, [{ id: "cleaningOwner" }, { id: "tnbOwner" }, { id: "maintenanceFee" }], [
      sel("A", "cleaningOwner"),
      sel("A", "maintenanceFee"),
    ]);
    const tsv = matrixToTsv(plan.matrix!, () => "x");
    expect(tsv).toBe("x\t\tx"); // middle (tnbOwner) is a blank → empty field
    expect(countCells(plan.matrix!)).toBe(2);
  });
});
