import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OwnerPropertyPage from "../owner-property";

// ─── Mock portal API fetch ─────────────────────────────────────────────────────

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROPERTY_FIXTURE = {
  data: {
    id: "prop-1",
    name: "Skyvilla Residences",
    address: {
      addressLine1: "Jalan Utama 12",
      addressLine2: "Taman Maju",
      city: "Kuala Lumpur",
      state: "Wilayah Persekutuan",
      postalCode: "50480",
      country: "Malaysia",
    },
    managerId: "mgr-abc123",
    units: [
      {
        listingId: "lst-1",
        unitCode: "A-101",
        occupancyStatus: "occupied",
        currentTenancy: {
          id: "ten-1",
          tenantDisplayName: "Ahmad bin Ismail",
          startDate: "2025-01-01",
          endDate: "2026-01-01",
          monthlyRentAmount: "1500.00",
        },
        deposits: [
          {
            id: "dep-1",
            type: "security",
            amount: "3000.00",
            status: "held",
          },
          {
            id: "dep-2",
            type: "utilities",
            amount: "500.00",
            status: "held",
          },
        ],
      },
    ],
    managementFeeConfig: {
      feeType: "percentage",
      feeValue: "10",
      sstPercent: "8",
      capAmount: "250.00",
    },
  },
};

// ─── Test wrapper ─────────────────────────────────────────────────────────────

/**
 * Wraps the page component with MemoryRouter at the correct route path so that
 * useParams can extract the `id` param.
 */
function wrap(ui: React.ReactElement, initialEntry = "/portal/owner-property/prop-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/portal/owner-property/:id" element={ui} />
          {/* fallback so MemoryRouter doesn't 404 on the back-link render */}
          <Route path="/portal/income-tax" element={<div>Income Tax</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OwnerPropertyPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders property name after data resolves", async () => {
    portalApiFetch.mockResolvedValue(PROPERTY_FIXTURE);
    render(wrap(<OwnerPropertyPage />));

    expect(await screen.findByText("Skyvilla Residences")).toBeInTheDocument();
  });

  it("renders unit code and tenant name", async () => {
    portalApiFetch.mockResolvedValue(PROPERTY_FIXTURE);
    render(wrap(<OwnerPropertyPage />));

    expect(await screen.findByText("A-101")).toBeInTheDocument();
    expect(await screen.findByText("Ahmad bin Ismail")).toBeInTheDocument();
  });

  it("renders deposit badges with formatted amounts", async () => {
    portalApiFetch.mockResolvedValue(PROPERTY_FIXTURE);
    render(wrap(<OwnerPropertyPage />));

    // Both deposits should appear
    expect(await screen.findByText("security")).toBeInTheDocument();
    expect(await screen.findByText("utilities")).toBeInTheDocument();
    expect(await screen.findByText("RM 3,000.00")).toBeInTheDocument();
    expect(await screen.findByText("RM 500.00")).toBeInTheDocument();
  });

  it("renders management fee config label", async () => {
    portalApiFetch.mockResolvedValue(PROPERTY_FIXTURE);
    render(wrap(<OwnerPropertyPage />));

    // "10% + 8% SST (cap RM 250.00)" — match partial substring
    const feeEl = await screen.findByText(/10%/);
    expect(feeEl).toBeInTheDocument();
    expect(feeEl.textContent).toMatch(/cap/i);
  });

  it("renders monthly rent using formatRM", async () => {
    portalApiFetch.mockResolvedValue(PROPERTY_FIXTURE);
    render(wrap(<OwnerPropertyPage />));

    expect(await screen.findByText(/RM 1,500\.00/)).toBeInTheDocument();
  });

  it("shows not-found empty state when query errors", async () => {
    portalApiFetch.mockRejectedValue(new Error("404 Not Found"));
    render(wrap(<OwnerPropertyPage />));

    expect(
      await screen.findByText("Property not found or not yours"),
    ).toBeInTheDocument();
  });
});
