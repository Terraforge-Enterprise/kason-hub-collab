import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChargeTable, type ChargeListItem } from "../charges-table";
import { getStatusTone } from "@/components/format";

const row: ChargeListItem = {
  id: "c1",
  chargeNumber: "RENT-2026-07-t1",
  partyName: "Alice Tenant",
  tenancyCode: "TCY-1",
  unitCode: "A-19-02",
  chargeType: "rent",
  status: "credited",
  dueDate: "2026-07-31T00:00:00.000Z",
  amount: 980,
  outstandingAmount: 0,
  currency: "MYR",
  invoiceNumber: null,
  documentNumber: "DEP-0007",
  events: [],
};

describe("ChargeTable — accounting docs additions", () => {
  it("renders the document number column", () => {
    render(<ChargeTable charges={[row]} />);
    expect(screen.getByText("DEP-0007")).toBeTruthy();
  });
  it("renders a dash when the charge has no document (draft / pre-cutover)", () => {
    render(<ChargeTable charges={[{ ...row, documentNumber: null, status: "draft" }]} />);
    expect(screen.getByText("Document")).toBeTruthy();
  });
  it("credited status gets the rose tone", () => {
    expect(getStatusTone("credited")).toBe("rose");
  });
});
