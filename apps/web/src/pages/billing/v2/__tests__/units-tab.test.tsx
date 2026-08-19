import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/lib/feature-flags", () => ({ isPhase2FlagEnabled: () => true }));

import { UnitsTab } from "../units-tab";
import type { ChargeGroup, GroupedChargeRow } from "../use-billing-v2";

const MONTH = "2026-07";

const wrap = (ui: React.ReactElement, qc?: QueryClient) => {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>,
  );
};

// --- Fixture builders --------------------------------------------------
// `row`/`groupWith` build fully-typed GroupedChargeRow/ChargeGroup fixtures
// with sensible defaults so each test only spells out the fields it cares
// about. `renderUnits` pre-seeds the react-query cache with the exact query
// key `useChargesGrouped` reads, so the component shows real data on its
// very first render (no `await waitFor` needed) — this file's pre-existing
// tests still use the mockResolvedValue + waitFor pattern since they render
// via the ordinary loading path.
let rowSeq = 0;
function row(
  overrides: Partial<GroupedChargeRow> & { track: GroupedChargeRow["track"] },
): GroupedChargeRow {
  rowSeq += 1;
  const amount = overrides.amount ?? 100;
  return {
    id: `row-${rowSeq}`,
    chargeNumber: `CHG-${rowSeq}`,
    partyName: "Test Tenant",
    tenancyCode: null,
    chargeType: "rent",
    categoryLabel: "Charge",
    status: "posted",
    displayStatus: "posted",
    dueDate: "2026-07-01T00:00:00.000Z",
    amount,
    outstandingAmount: amount,
    currency: "MYR",
    documentId: null,
    documentNumber: null,
    ...overrides,
  };
}

let groupSeq = 0;
function groupWith(charges: GroupedChargeRow[], overrides: Partial<ChargeGroup> = {}): ChargeGroup {
  groupSeq += 1;
  return {
    key: `unit:g${groupSeq}`,
    kind: "unit",
    label: `A-${groupSeq}`,
    propertyName: "Tower A",
    apartmentId: `apt-${groupSeq}`,
    subtitle: "Test Tenant",
    statementStatus: null,
    ivownDocumentId: null,
    ivownDocumentNumber: null,
    totals: {
      amount: charges.reduce((s, c) => s + c.amount, 0),
      outstanding: charges.reduce((s, c) => s + c.outstandingAmount, 0),
      chargeCount: charges.length,
    },
    charges,
    ...overrides,
  };
}

function renderUnits(groups: ChargeGroup[]) {
  const data = { month: MONTH, groupBy: "unit", groups };
  apiFetchMock.mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Pre-seed the cache under the exact key useChargesGrouped(MONTH, "unit")
  // reads, so the component renders real data synchronously (no loading
  // skeleton) and tests can assert immediately without `await waitFor`.
  qc.setQueryData(["billing", "charges", "grouped", { month: MONTH, groupBy: "unit" }], data);
  return wrap(<UnitsTab month={MONTH} />, qc);
}

const GROUPS = {
  month: MONTH, groupBy: "unit",
  groups: [
    {
      key: "unit:u1", kind: "unit", label: "A-19-02", propertyName: "Tower A",
      apartmentId: "apt-1", subtitle: "Ahmad Faizal bin Ismail", statementStatus: null,
      ivownDocumentId: null, ivownDocumentNumber: null,
      totals: { amount: 1590, outstanding: 90, chargeCount: 3 },
      charges: [{
        id: "c1", chargeNumber: "RENT-202607-t1", partyName: "Ahmad Faizal bin Ismail",
        tenancyCode: "T-1", chargeType: "rent", categoryLabel: "Monthly rental",
        status: "posted", displayStatus: "posted", dueDate: "2026-07-01T00:00:00.000Z",
        amount: 1500, outstandingAmount: 0, currency: "MYR",
        documentId: "d1", documentNumber: "DEP-0001", track: "tenant_fees",
      }],
    },
    {
      key: "carpark:cp1", kind: "carpark", label: "P-12", propertyName: "",
      apartmentId: null, subtitle: "Tan Wei Ming", statementStatus: null,
      ivownDocumentId: null, ivownDocumentNumber: null,
      totals: { amount: 150, outstanding: 150, chargeCount: 1 },
      charges: [],
    },
  ],
};

// NOTE: intentionally no `beforeEach(() => apiFetchMock.mockReset())` here.
// Each test below sets a full mockResolvedValue/mockRejectedValue
// implementation before rendering (no cross-test leakage risk), and a
// beforeEach-scoped mock reset paired with a query that rejects on mount
// reproducibly trips an unhandled-rejection false failure in this
// React 19 + TanStack Query v5 + Vitest 3 combo — confirmed with a minimal
// bare useQuery repro carrying none of this file's component code.
describe("UnitsTab", () => {
  it("renders groups with header identity, totals, and settlement pill", async () => {
    apiFetchMock.mockResolvedValue(GROUPS);
    wrap(<UnitsTab month={MONTH} />);
    await waitFor(() => expect(screen.getByText("A-19-02")).toBeTruthy());
    expect(screen.getByText(/Ahmad Faizal/)).toBeTruthy();
    // Both groups are fully collected (or unbilled) on the tenant/pass-through
    // side, so both header pills read Settled — replaces the old X/Y posted
    // fraction assertion (Spec 1 R2).
    expect(screen.getAllByText("Settled").length).toBe(2);
    expect(screen.getByText("P-12")).toBeTruthy();
    expect(screen.getByText("DEP-0001")).toBeTruthy();
    // §3.2 unit-workspace deep link uses apartmentId, never the Listing id
    expect(screen.getByRole("link", { name: "A-19-02" }).getAttribute("href")).toBe(
      "/tenancy/owner-ledger/unit/apt-1",
    );
  });
  it("empty month: EmptyState + billing-grid link", async () => {
    apiFetchMock.mockResolvedValue({ month: MONTH, groupBy: "unit", groups: [] });
    wrap(<UnitsTab month={MONTH} />);
    await waitFor(() => expect(screen.getByText(/no charges for this month/i)).toBeTruthy());
    // The old Tenant Tracker link was repointed at the Tenant & Owner Billing
    // grid when the tracker UI was removed (2026-08-06).
    expect(
      screen.getByRole("link", { name: /tenant & owner billing/i }).getAttribute("href"),
    ).toBe("/billing/tenant-owner-billing");
  });
  it("error state: danger callout + retry", async () => {
    apiFetchMock.mockRejectedValue(new Error("boom"));
    wrap(<UnitsTab month={MONTH} />);
    await waitFor(() => expect(screen.getByText(/couldn.t load unit charges/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  // R1/R2 — bands + header
  it("renders track bands in flow order; no posted fraction", () => {
    renderUnits([groupWith([
      row({ id: "u1", track: "pass_through", amount: 1500, outstandingAmount: 1500, categoryLabel: "Monthly rental" }),
      row({ id: "u2", track: "owner", amount: 150, outstandingAmount: 150, categoryLabel: "Management fee", displayStatus: "on_statement" }),
    ])]);
    const bands = screen.getAllByText(/Pass-through — collected|Owner charges — deducted/);
    expect(bands[0]).toHaveTextContent(/Pass-through/); // pass_through before owner
    expect(screen.getByText(/RM.*1,500.*to collect/i)).toBeInTheDocument();
    expect(screen.queryByText(/\d+\/\d+ posted/)).toBeNull();
  });
  it("owner-only unit shows one band + Settled (owner excluded from to-collect)", () => {
    renderUnits([groupWith([row({ id: "o1", track: "owner", amount: 250, outstandingAmount: 250, displayStatus: "on_statement" })])]);
    expect(screen.getByText(/Owner charges — deducted/)).toBeInTheDocument();
    expect(screen.queryByText(/Tenant fees|Pass-through/)).toBeNull();
    expect(screen.getByText("Settled")).toBeInTheDocument();
  });

  // R3 — RM0 collapse
  it("zero-value: RM0 rows collapse under an expander, reveal on click", async () => {
    renderUnits([groupWith([
      row({ id: "u1", track: "pass_through", amount: 1500, chargeNumber: "RENT-1", documentNumber: "DEP-1" }),
      row({ id: "u2", track: "pass_through", amount: 0, chargeNumber: "UTIL-1", documentNumber: "DEP-2" }),
    ])]);
    expect(screen.queryByText("DEP-2")).toBeNull();
    await userEvent.click(screen.getByText(/1 zero-value line/i));
    expect(screen.getByText("DEP-2")).toBeInTheDocument();
  });

  // Boundary: plural expander label at 2+ zero rows, and the non-zero row in
  // the same band still renders normally alongside the collapsed ones.
  it("pluralizes the zero-value expander at 2+ rows", async () => {
    renderUnits([groupWith([
      row({ id: "n1", track: "pass_through", amount: 500, chargeNumber: "RENT-9", documentNumber: "DEP-9" }),
      row({ id: "z1", track: "pass_through", amount: 0, chargeNumber: "UTIL-2", documentNumber: "DEP-10" }),
      row({ id: "z2", track: "pass_through", amount: 0, chargeNumber: "UTIL-3", documentNumber: "DEP-11" }),
    ])]);
    expect(screen.getByText("DEP-9")).toBeInTheDocument();
    expect(screen.getByText(/2 zero-value lines/i)).toBeInTheDocument();
    expect(screen.queryByText("DEP-10")).toBeNull();
    expect(screen.queryByText("DEP-11")).toBeNull();
    await userEvent.click(screen.getByText(/2 zero-value lines/i));
    expect(screen.getByText("DEP-10")).toBeInTheDocument();
    expect(screen.getByText("DEP-11")).toBeInTheDocument();
  });

  // Boundary: a present (non-empty) fully-collected charge reads Settled —
  // distinct from the "no charges at all" case below.
  it("fully collected but present non-owner charge shows Settled", () => {
    renderUnits([groupWith([
      row({ id: "p1", track: "pass_through", amount: 800, outstandingAmount: 0, chargeNumber: "RENT-PAID", documentNumber: "DEP-20" }),
    ])]);
    expect(screen.getByText("Settled")).toBeInTheDocument();
    expect(screen.getByText("DEP-20")).toBeInTheDocument();
  });

  // Error/edge: a group with no charges at all must not crash and must not
  // render any band headers.
  it("group with no charges at all renders no bands and Settled, without crashing", () => {
    renderUnits([groupWith([])]);
    expect(screen.queryByText(/Tenant fees|Pass-through|Owner charges/)).toBeNull();
    expect(screen.getByText("Settled")).toBeInTheDocument();
  });

  // Edge: a band whose rows are ALL zero-value collapses entirely (nothing
  // to show before the expander is clicked), yet the band header itself and
  // its (zero) subtotal still render.
  it("band with only zero-amount rows collapses entirely", async () => {
    renderUnits([groupWith([
      row({ id: "z1", track: "pass_through", amount: 0, chargeNumber: "ADJ-1", documentNumber: "DEP-30" }),
      row({ id: "z2", track: "pass_through", amount: 0, chargeNumber: "ADJ-2", documentNumber: "DEP-31" }),
    ])]);
    expect(screen.getByText(/Pass-through — collected/)).toBeInTheDocument();
    expect(screen.getByText(/2 zero-value lines/i)).toBeInTheDocument();
    expect(screen.queryByText("DEP-30")).toBeNull();
    await userEvent.click(screen.getByText(/2 zero-value lines/i));
    expect(screen.getByText("DEP-30")).toBeInTheDocument();
    expect(screen.getByText("DEP-31")).toBeInTheDocument();
  });

  // R5 — document-first column
  it("document-first: documentNumber primary, chargeNumber on title; falls back when no doc", () => {
    renderUnits([groupWith([
      row({ id: "u1", track: "pass_through", amount: 1500, chargeNumber: "AC-uuid", documentNumber: "DEP-8" }),
      row({ id: "u2", track: "pass_through", amount: 300, chargeNumber: "CHG-x", documentNumber: null }),
    ])]);
    expect(screen.getByText("DEP-8")).toBeInTheDocument();
    expect(screen.getByTitle("AC-uuid")).toBeInTheDocument();
    expect(screen.getByText("CHG-x")).toBeInTheDocument(); // fallback
  });
});
