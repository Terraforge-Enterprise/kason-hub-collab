// LineItemsTab — per-line unit identity.
//
// A COMBINED owner statement (IVOWN) mints ONE document spanning every unit the
// owner holds, so the drawer header's Property/Unit both read "—" and each line
// must name its own unit. Without it, three "Management fee" lines render
// identically and the reader cannot tell which unit each belongs to.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { BillingDocumentLineDto } from "@kason/shared";
import { LineItemsTab } from "../line-items-tab";

function line(over: Partial<BillingDocumentLineDto> & { id: string }): BillingDocumentLineDto {
  return {
    chargeId: `ch-${over.id}`,
    description: "Management fee",
    amount: "220.00",
    sstRate: "8",
    sstAmount: "17.60",
    categoryName: "Management fee",
    unitCode: null,
    paid: "0.00",
    outstanding: "220.00",
    originalAmount: "220.00",
    debitAdjustmentAmount: "0.00",
    creditAdjustmentAmount: "0.00",
    netAdjustmentAmount: "0.00",
    adjustedAmount: "220.00",
    // Defaults to the raw SST, which is exactly what the server sends for a charge
    // carrying no notes — so an unadjusted line is byte-identical to before.
    adjustedSstAmount: over.sstAmount ?? "17.60",
    allocationBasis: "exact",
    adjustments: [],
    attachments: [],
    isTax: false,
    taxParentChargeId: null,
    ...over,
  } as BillingDocumentLineDto;
}

describe("LineItemsTab — per-line unit identity", () => {
  it("names the unit on every line of a multi-unit document", () => {
    render(
      <LineItemsTab
        isLoading={false}
        lines={[
          line({ id: "l1", unitCode: "A-01-01" }),
          line({ id: "l2", unitCode: "A-01-02" }),
          line({ id: "l3", unitCode: "B-02-07 · Master Room", amount: "150.00", outstanding: "150.00" }),
        ]}
      />,
    );
    // All three descriptions read "Management fee" — the unit is the ONLY thing
    // that tells them apart, so it must be on screen.
    expect(screen.getByText("A-01-01")).toBeInTheDocument();
    expect(screen.getByText("A-01-02")).toBeInTheDocument();
    expect(screen.getByText("B-02-07 · Master Room")).toBeInTheDocument();
  });

  it("keeps the unit inside its own row, not merged across lines", () => {
    render(
      <LineItemsTab
        isLoading={false}
        lines={[line({ id: "l1", unitCode: "A-01-01" }), line({ id: "l2", unitCode: "A-01-02" })]}
      />,
    );
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryByText("Management fee"));
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("A-01-01")).toBeInTheDocument();
    expect(within(rows[0]).queryByText("A-01-02")).toBeNull();
    expect(within(rows[1]).getByText("A-01-02")).toBeInTheDocument();
  });

  it("renders a unit-less line without a dangling separator", () => {
    render(<LineItemsTab isLoading={false} lines={[line({ id: "l1", unitCode: null })]} />);
    const row = screen.getAllByRole("row").find((r) => within(r).queryByText("Management fee"))!;
    // The meta line is "<category> · SST 8%" — it must not open with a stray "·".
    expect(row.textContent).not.toMatch(/·\s*Management fee/);
    expect(row.textContent).toContain("SST 8%");
  });
});

describe("LineItemsTab — per-line SST column (user ask 2026-08-07)", () => {
  it("shows the line's SST amount in its own column, and a dash for untaxed lines", () => {
    render(
      <LineItemsTab
        isLoading={false}
        lines={[
          line({ id: "l1", sstRate: "8", sstAmount: "17.60" }),
          line({ id: "l2", description: "Renewal fee", sstRate: "0", sstAmount: "0.00" }),
        ]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "SST" })).toBeInTheDocument();
    const taxed = screen.getAllByRole("row").find((r) => within(r).queryByText("Management fee"))!;
    expect(within(taxed).getByText("RM 17.60")).toBeInTheDocument();
    const untaxed = screen.getAllByRole("row").find((r) => within(r).queryByText("Renewal fee"))!;
    // The untaxed line renders "—" in the SST cell (cells[3]), never "RM 0.00" noise.
    expect(untaxed.querySelectorAll("td")[3]!.textContent).toBe("—");
  });

  it("shows the NOTE-ADJUSTED SST, not the original — a part-credited line owes less tax", () => {
    // Reported 2026-08-17: RM 1.00 @ 8% credited by RM 0.50. The credit note itself
    // declares RM 0.04 of tax relief (its total is 0.54, not 0.58), but the column
    // went on printing the full RM 0.08 because it rendered the raw stored
    // `sstAmount`. The server now sends `adjustedSstAmount`; this renders THAT.
    render(
      <LineItemsTab
        isLoading={false}
        lines={[
          line({
            id: "l1",
            description: "Expense with SST",
            amount: "1.00",
            sstRate: "8",
            sstAmount: "0.08",
            adjustedSstAmount: "0.04",
            originalAmount: "1.00",
            creditAdjustmentAmount: "0.50",
            netAdjustmentAmount: "-0.50",
            adjustedAmount: "0.50",
            outstanding: "0.54",
            adjustments: [
              { noteId: "cn1", docType: "credit_note", documentNumber: "CN-0002", amountCents: 50 },
            ],
          }),
        ]}
      />,
    );
    const row = screen.getAllByRole("row").find((r) => within(r).queryByText("Expense with SST"))!;
    expect(within(row).getByText("RM 0.04")).toBeInTheDocument();
    // The pre-credit figure must be gone — showing both is the confusion itself.
    expect(within(row).queryByText("RM 0.08")).toBeNull();
    // Adjusted base + adjusted SST is what the tenant actually owes.
    expect(within(row).getByText("RM 0.54")).toBeInTheDocument();
  });

  it("does NOT print the SST twice — the sibling tax line is folded into its base", () => {
    // UAT IVOWN-0013, verbatim: an owner-borne grid expense of RM 1.00 @ 8% (whose
    // SST is minted as its own settleable Charge) plus a RM 0.80 cleaning expense.
    // The document reads subtotal 1.80 / SST 0.08 / total 1.88. Rendering the tax
    // sibling as a third line item showed RM 0.08 twice and left the Amount column
    // summing to 1.88 against a printed Subtotal of 1.80.
    render(
      <LineItemsTab
        isLoading={false}
        lines={[
          line({
            id: "base", chargeId: "ch-base", description: "1", categoryName: "Management fee",
            unitCode: "A-22-11", amount: "1.00", originalAmount: "1.00", adjustedAmount: "1.00",
            sstRate: "8", sstAmount: "0.08", outstanding: "1.00",
          }),
          line({
            id: "tax", chargeId: "ch-tax", description: "1 — SST 8%", categoryName: "Management fee",
            unitCode: "A-22-11", amount: "0.08", originalAmount: "0.08", adjustedAmount: "0.08",
            sstRate: "0", sstAmount: "0.00", outstanding: "0.08",
            isTax: true, taxParentChargeId: "ch-base",
          }),
          line({
            id: "cleaning", chargeId: "ch-clean", description: "1", categoryName: "Cleaning (owner)",
            unitCode: "A-22-11", amount: "0.80", originalAmount: "0.80", adjustedAmount: "0.80",
            sstRate: "0", sstAmount: "0.00", outstanding: "0.80",
          }),
        ]}
      />,
    );

    // Two line rows, not three — the "— SST 8%" row is gone from the reader's view.
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(screen.queryByText("1 — SST 8%")).toBeNull();

    // The SST is still shown — exactly once, in the base line's own SST column.
    expect(screen.getByText("RM 0.08")).toBeInTheDocument();

    // Original column: 1.00 + 0.80 = 1.80 = the document's Subtotal. It used to
    // include the tax line's 0.08 and sum to the TOTAL instead.
    const originals = bodyRows.map((r) => r.querySelectorAll("td")[2]!.textContent);
    expect(originals).toEqual(["RM 1.00", "RM 0.80"]);

    // Outstanding column: the tax's 0.08 is merged into its base (1.00 → 1.08), so
    // the column still sums to the document balance of 1.88.
    const outstanding = bodyRows.map((r) => r.querySelectorAll("td")[7]!.textContent);
    expect(outstanding[0]).toContain("RM 1.08");
    expect(outstanding[1]).toContain("RM 0.80");
  });

  it("keeps note child-rows aligned under the Adjustments column", () => {
    render(
      <LineItemsTab
        isLoading={false}
        lines={[
          line({
            id: "l1",
            netAdjustmentAmount: "-30.00",
            adjustedAmount: "190.00",
            adjustments: [
              { noteId: "n1", docType: "credit_note", documentNumber: "CN-0003", amountCents: 3000 },
            ] as BillingDocumentLineDto["adjustments"],
          }),
        ]}
      />,
    );
    // The child row names the note; a header row of 8 columns must not shift it.
    expect(screen.getByText(/CN-0003/)).toBeInTheDocument();
    const header = screen.getAllByRole("row")[0];
    expect(within(header).getAllByRole("columnheader")).toHaveLength(8);
  });
});
