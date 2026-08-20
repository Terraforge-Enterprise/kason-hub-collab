import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
// recharts ResponsiveContainer measures 0×0 in jsdom; stub it to a fixed box so
// the chart subtree mounts deterministically (mirrors the board's
// getBoundingClientRect-zero caveat).
vi.mock("recharts", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 280 }}>{children}</div>
    ),
  };
});

import { apiFetch } from "@/lib/api-client";
import { SprintTrendsChart } from "../sprint-trends-chart";

const apiFetchMock = vi.mocked(apiFetch);

function renderChart(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe("SprintTrendsChart", () => {
  it("fetches trends and renders the chart card title + chart wrapper", async () => {
    apiFetchMock.mockResolvedValue({
      data: [
        { seq: 1, name: null, completed: 4, carried: 1, completionRate: 80 },
        { seq: 2, name: "Beta", completed: 7, carried: 2, completionRate: 78 },
      ],
    } as never);
    renderChart(<SprintTrendsChart />);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("/sprints/trends")),
    );
    expect(screen.getByText("Sprint trends")).toBeInTheDocument();
    // Wait for the query data to flush before the data-dependent wrapper renders.
    expect(await screen.findByTestId("sprint-trends-chart")).toBeInTheDocument();
  });

  it("passes the window through to the trends endpoint", async () => {
    apiFetchMock.mockResolvedValue({ data: [] } as never);
    renderChart(<SprintTrendsChart window={5} />);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/sprints/trends?window=5"),
    );
  });

  it("shows an empty placeholder when no completed sprints", async () => {
    apiFetchMock.mockResolvedValue({ data: [] } as never);
    renderChart(<SprintTrendsChart />);
    expect(await screen.findByText("No completed sprints yet")).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-trends-chart")).toBeNull();
  });
});
