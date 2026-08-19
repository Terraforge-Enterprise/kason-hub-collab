// Tenant Billing → Overview: the credit-on-account disclosure.
//
// Context: a credit note raised against an already-paid charge leaves the tenant
// holding money. Nothing surfaced it — the portal showed only what they OWED, so
// a tenant could hold RM50 and never know. These tests pin the two properties
// that make the disclosure safe as well as visible:
//   1. it appears when they hold credit, and
//   2. it NEVER reduces "Amount to pay" — available credit settles FUTURE bills,
//      so netting it into the current figure would invite a short payment.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PortalDashboardResponse } from "@kason/shared";
import { OverviewTab } from "../billing/overview-tab";

type Balance = PortalDashboardResponse["balance"];

function balance(over: Partial<Balance> = {}): Balance {
  return {
    totalCharges: 650,
    totalPayments: 475,
    totalCredits: 0,
    netBalance: 175,
    unpaidCount: 3,
    overdueAmount: 0,
    overdueCount: 0,
    creditAvailable: 0,
    currency: "MYR",
    ...over,
  };
}

function renderTab(b: Balance) {
  return render(
    <MemoryRouter>
      <OverviewTab balance={b} />
    </MemoryRouter>,
  );
}

describe("OverviewTab — credit on account", () => {
  it("shows the unspent credit a tenant holds", () => {
    renderTab(balance({ creditAvailable: 50 }));
    const block = screen.getByTestId("credit-available");
    expect(within(block).getByText(/50\.00/)).toBeTruthy();
    expect(within(block).getByText(/next bill/i)).toBeTruthy();
  });

  it("renders nothing when there is no credit — no empty row, no 'RM 0.00'", () => {
    renderTab(balance({ creditAvailable: 0 }));
    expect(screen.queryByTestId("credit-available")).toBeNull();
  });

  it("does NOT net available credit into 'Amount to pay'", () => {
    // The money-safety property. Available credit has not settled anything yet;
    // subtracting it here would tell the tenant to pay less than they owe today
    // and leave the charges open.
    renderTab(balance({ netBalance: 175, creditAvailable: 50 }));
    expect(screen.getByText("RM 175.00")).toBeTruthy();
    expect(screen.queryByText("RM 125.00")).toBeNull();
  });

  it("reports APPLIED credit separately, and the breakdown foots", () => {
    // Applying a credit mints a real posted Payment, so without the split the
    // credit leg would be reported as cash the tenant "paid".
    // 650 billed − 50 credit − 475 cash = 125 due.
    renderTab(balance({ totalCharges: 650, totalCredits: 50, totalPayments: 475, netBalance: 125 }));
    // formatRM puts the sign after the unit: "RM -50.00".
    expect(screen.getByText("RM 650.00")).toBeTruthy();
    expect(screen.getByText("RM -50.00")).toBeTruthy();
    expect(screen.getByText("RM -475.00")).toBeTruthy();
    expect(screen.getByText("RM 125.00")).toBeTruthy();
  });
});
