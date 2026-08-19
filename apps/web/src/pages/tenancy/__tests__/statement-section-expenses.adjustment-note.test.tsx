/**
 * §5 Expense Breakdown — the credit/debit note behind each row.
 *
 * Reported 2026-08-17: §4 printed "WiFi · Debit note +RM 0.05" beside the income
 * line a note had moved, while §5 printed only the adjusted number. The owner could
 * see that "test own exp sst" cost RM 0.50 but not that it was minted at RM 1.00 and
 * carries a credit note — nothing on the page named the document behind the figure.
 *
 * Run:
 *   npx vitest run src/pages/tenancy/__tests__/statement-section-expenses.adjustment-note.test.tsx
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { StatementSectionExpenses } from "@/pages/tenancy/owner-statement/statement-section-expenses";
import type { YannieSections } from "@/api/owner-ledger";

type ExpenseData = YannieSections["expenseBreakdown"];
type ExpenseRow = ExpenseData["rows"][number];

function makeRow(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    category: "Owner expense",
    categoryKey: "owner_receivable",
    description: "test own exp sst",
    amount: "0.50",
    sstAmount: "0.04",
    paymentStatus: "pending",
    ...overrides,
  };
}

function renderExpenses(rows: ExpenseRow[]) {
  const data: ExpenseData = {
    rows,
    totalExpenses: rows
      .reduce((acc, r) => acc + Number(r.amount) + Number(r.sstAmount), 0)
      .toFixed(2),
  };
  // useExpenseProofs is called unconditionally (rules of hooks) and stays DISABLED
  // without a proof scope, so the provider is required but never fetches.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // No proof scope ⇒ no Bill column, the read-only shape both the portal and the
  // admin page share for everything this file asserts.
  return render(
    <QueryClientProvider client={qc}>
      <StatementSectionExpenses data={data} />
    </QueryClientProvider>,
  );
}

describe("StatementSectionExpenses — the note behind an adjusted row", () => {
  it("names the note and its amount beside the row it moved", () => {
    renderExpenses([makeRow({ adjustmentNote: "Credit note -RM 0.50" })]);

    const note = screen.getByTestId("expense-row-adjustment-0");
    expect(note.textContent).toContain("Credit note");
    expect(note.textContent).toContain("0.50");
  });

  it("keeps the description readable alongside it", () => {
    // Both must survive: the note is additive, never a replacement for the line's
    // own name — an owner reconciling needs to know WHICH expense was credited.
    renderExpenses([makeRow({ adjustmentNote: "Credit note -RM 0.50" })]);

    expect(screen.getByText("test own exp sst")).toBeTruthy();
    expect(screen.getByTestId("expense-row-adjustment-0")).toBeTruthy();
  });

  it("shows both directions when a row carries a debit AND a credit note", () => {
    renderExpenses([
      makeRow({ adjustmentNote: "Debit note +RM 80.00 · Credit note -RM 30.00" }),
    ]);

    const note = screen.getByTestId("expense-row-adjustment-0");
    expect(note.textContent).toContain("Debit note +RM 80.00");
    expect(note.textContent).toContain("Credit note -RM 30.00");
  });

  it("renders nothing extra on an un-adjusted row", () => {
    renderExpenses([makeRow()]);
    expect(screen.queryByTestId("expense-row-adjustment-0")).toBeNull();
  });

  it("annotates only the row the note belongs to", () => {
    renderExpenses([
      makeRow({ description: "Maintenance 202608", amount: "0.30", sstAmount: "0.00" }),
      makeRow({ description: "test own exp sst", adjustmentNote: "Credit note -RM 0.50" }),
    ]);

    expect(screen.queryByTestId("expense-row-adjustment-0")).toBeNull();
    expect(screen.getByTestId("expense-row-adjustment-1").textContent).toContain(
      "Credit note -RM 0.50",
    );
  });
});
