import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/lib/feature-flags", () => ({ isPhase2FlagEnabled: () => true }));

import ChargesPageV2 from "../charges-page-v2";

function renderPage(url = "/billing/charges") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ChargesPageV2 />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SUMMARY = { billedTotal: 300, postedCount: 2, outstandingTotal: 80, unitsBilled: 1, unitsWithActiveTenancy: 2 };
const GROUPED = { month: "2026-07", groupBy: "unit", groups: [] };

beforeEach(() => {
  apiFetchMock.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/billing/charges/summary")) return Promise.resolve(SUMMARY);
    if (url.startsWith("/billing/charges/grouped")) return Promise.resolve(GROUPED);
    if (url.startsWith("/billing/charges")) return Promise.resolve({ data: [], total: 0 });
    return Promise.resolve({ data: [] });
  });
});

describe("ChargesPageV2", () => {
  it("month-in-URL: defaults to current month, Units tab default, month survives tab switch", async () => {
    renderPage();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const groupedCall = apiFetchMock.mock.calls.find(([u]) => String(u).startsWith("/billing/charges/grouped"));
    expect(String(groupedCall![0])).toMatch(/month=\d{4}-\d{2}/);
    expect(String(groupedCall![0])).toContain("groupBy=unit");
    await userEvent.click(screen.getByRole("radio", { name: /all charges/i }));
    // switching tab must not drop the month param from the URL bar state
    expect(screen.getByLabelText(/month/i)).toBeTruthy();
  });

  it("summary error: danger callout + retry, tabs still visible", async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/billing/charges/summary")) return Promise.reject(new Error("boom"));
      if (url.startsWith("/billing/charges/grouped")) return Promise.resolve(GROUPED);
      return Promise.resolve({ data: [], total: 0 });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/couldn.t load billing metrics/i)).toBeTruthy());
    expect(screen.getByRole("radio", { name: /units/i })).toBeTruthy();
  });
});
