// Feature Flags page: pairs the API's live values with this bundle's VITE
// twins and calls out web-ON/API-OFF splits — the silent-failure shape that
// shipped "expenses never reach the invoice".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PHASE2_FLAGS } from "@kason/shared";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { apiFetch, ApiError } from "@/lib/api-client";
import FeatureFlagsSection from "../feature-flags-section";

const apiFetchMock = vi.mocked(apiFetch);

/** API response with every registry flag off except `on`. */
function flagsResponse(on: string[] = []) {
  return { flags: PHASE2_FLAGS.map((name) => ({ name, api: on.includes(name) })) };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <FeatureFlagsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("FeatureFlagsSection", () => {
  it("renders one row per registry flag with API and Web values", async () => {
    apiFetchMock.mockResolvedValue(flagsResponse(["ENABLE_PHASE2_METER"]));
    renderSection();
    expect(await screen.findByText("ENABLE_PHASE2_METER")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(PHASE2_FLAGS.length + 1); // + header
  });

  it("web-ON/API-OFF renders the SPLIT badge and the danger callout", async () => {
    vi.stubEnv("VITE_ENABLE_BILL_EXPENSES_AS_CHARGES", "true");
    apiFetchMock.mockResolvedValue(flagsResponse([])); // API side off
    renderSection();
    expect(await screen.findByText("SPLIT — web on, API off")).toBeInTheDocument();
    expect(screen.getByText(/Split-brain detected/)).toBeInTheDocument();
    expect(screen.getByText(/ENABLE_BILL_EXPENSES_AS_CHARGES/, { selector: "div,p,span" })).toBeInTheDocument();
  });

  it("API-ON/web-OFF renders the legal API-only badge, no split warning", async () => {
    // A server-side-only flag (a cron gate): there is no VITE_ counterpart to turn on,
    // so API-on/web-off is its normal state, not a split brain. Previously keyed on
    // ENABLE_AUTO_OFFSET_ON_RENT, which was removed from the registry (2026-08-16) when
    // the offset became unconditional — leaving this test with no row to find.
    apiFetchMock.mockResolvedValue(flagsResponse(["ENABLE_OWNER_STATEMENT_AUTO_SEND"]));
    renderSection();
    expect(await screen.findByText("API-only")).toBeInTheDocument();
    expect(screen.queryByText(/Split-brain detected/)).toBeNull();
  });

  it("403 from the API shows the manager-only note instead of a broken table", async () => {
    apiFetchMock.mockRejectedValue(new ApiError("forbidden", 403));
    renderSection();
    expect(await screen.findByText(/needs the manager role/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
