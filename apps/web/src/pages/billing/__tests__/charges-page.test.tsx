import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Spec §4.8 gap: GET /billing/charges register was unpaginated at 100+ unit
// scale. ChargesPage now runs TWO queries — one server-paginated (feeds the
// register table + pager), one unpaginated full-list (feeds the ChargeForms
// post/void pickers + header metrics, unchanged from before this fix).

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import ChargesPage from "../charges-page";

function chargeRow(n: number) {
  return {
    id: `c${n}`,
    chargeNumber: `CHG-${String(n).padStart(3, "0")}`,
    partyName: `Party ${n}`,
    tenancyCode: null,
    unitCode: null,
    chargeType: "rent",
    status: n % 2 === 0 ? "posted" : "draft",
    dueDate: "2026-07-01T00:00:00.000Z",
    amount: 100,
    outstandingAmount: 50,
    currency: "MYR",
    invoiceNumber: null,
    documentNumber: null,
    events: [],
  };
}

// 30 charges total org-wide; page 1 of a pageSize=25 register shows the
// first 25, page 2 shows the remaining 5. The FULL list (no params) always
// returns all 30 — this is what feeds ChargeForms + the header metrics.
const FULL_LIST = Array.from({ length: 30 }, (_, i) => chargeRow(i + 1));
const PAGE_1 = FULL_LIST.slice(0, 25);
const PAGE_2 = FULL_LIST.slice(25, 30);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ChargesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/billing/charges?page=2")) {
      return Promise.resolve({ data: PAGE_2, total: 30 });
    }
    if (path.startsWith("/billing/charges?page=")) {
      return Promise.resolve({ data: PAGE_1, total: 30 });
    }
    if (path === "/billing/charges") {
      // The unpaginated full-list call — NO page params, byte-identical to
      // the pre-4.8 shape.
      return Promise.resolve({ data: FULL_LIST });
    }
    if (path === "/tenancy/tenancies") return Promise.resolve({ data: [] });
    if (path === "/parties/tenants") return Promise.resolve({ data: [] });
    if (path === "/inventory/units") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
});

describe("ChargesPage — pagination (spec §4.8 gap)", () => {
  it("requests page 1 with the default pageSize (25) on first render", async () => {
    renderPage();
    await screen.findByText("CHG-001");
    const calls = apiFetch.mock.calls.map((c) => c[0] as string);
    expect(calls.some((p) => p === "/billing/charges?page=1&pageSize=25")).toBe(true);
    // AND still calls the unpaginated full-list endpoint (ChargeForms/metrics).
    expect(calls.some((p) => p === "/billing/charges")).toBe(true);
  });

  it("shows the pager summary and renders only the current page's rows", async () => {
    renderPage();
    await screen.findByText("CHG-001");
    expect(screen.getByText("Page 1 of 2 — 30 charge(s)")).toBeTruthy();
    // Page-2-only row is not present on page 1.
    expect(screen.queryByText("CHG-026")).toBeNull();
  });

  it("Next fetches page 2 and updates the visible rows", async () => {
    renderPage();
    await screen.findByText("CHG-001");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      const calls = apiFetch.mock.calls.map((c) => c[0] as string);
      expect(calls.some((p) => p === "/billing/charges?page=2&pageSize=25")).toBe(true);
    });
    await screen.findByText("CHG-026");
    expect(screen.getByText("Page 2 of 2 — 30 charge(s)")).toBeTruthy();
  });

  it("Previous is disabled on page 1; Next is disabled on the last page", async () => {
    renderPage();
    await screen.findByText("CHG-001");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("CHG-026");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).not.toBeDisabled();
  });

  it("ChargeForms post/void pickers list ALL 30 charges, not just the visible page", async () => {
    renderPage();
    await screen.findByText("CHG-001");
    // The post-charge <select> should contain an option from page 2's range
    // even while page 1 is displayed in the table — proves the picker is fed
    // by the unpaginated full-list query, not the paginated one.
    const selects = screen.getAllByRole("combobox");
    const optionTexts = selects.flatMap((s) =>
      Array.from(s.querySelectorAll("option")).map((o) => o.textContent),
    );
    expect(optionTexts.some((t) => t?.includes("CHG-030"))).toBe(true);
  });

  it("header metrics reflect the FULL org-wide list (30), not the 25-row page", async () => {
    renderPage();
    await screen.findByText("CHG-001");
    expect(screen.getByText("30")).toBeTruthy(); // "Charges" metric
  });
});
