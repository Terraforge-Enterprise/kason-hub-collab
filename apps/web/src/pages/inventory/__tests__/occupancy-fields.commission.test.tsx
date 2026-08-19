/**
 * Task 7: <OccupancyFields> commission checkbox + SST-bearer select, wired to
 * the rent-preview query's two new optional params (firstMonthIsCommission,
 * commissionSstBearer) and to the extended <FirstMonthPreviewCard> (Task 6).
 * Display-only -- no money moves; the checkbox/select are controlled props
 * (state lives in the parent form), matching the existing
 * onSelectTenant/onChange controlled-prop pattern in this file's siblings.
 *
 * Flag stub follows occupancy-fields.monthly-rent.test.tsx exactly: the
 * component reads ENABLE_PHASE2_RESERVATION_GATED_TENANCY via
 * isPhase2FlagEnabled at module eval time, so @/lib/feature-flags must be
 * mocked ON before importing "../occupancy-fields".
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn().mockResolvedValue({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OccupancyFields } from "../occupancy-fields";
import { apiFetch } from "@/lib/api-client";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const base = {
  occupancyStatus: "occupied" as const,
  tenantPartyId: null, tenantName: "", tenantIdType: null,
  tenantIdNumberMasked: null, tenantPhone: null,
  moveInDate: "2026-08-01", moveOutDate: "", monthlyRent: "3000",
  onSelectTenant: vi.fn(), onClearTenant: vi.fn(), onChange: vi.fn(), errors: {},
};

describe("<OccupancyFields> — commission checkbox + SST bearer (flag ON)", () => {
  it("checked: sends firstMonthIsCommission=true + commissionSstBearer, and renders the KAEN commission line", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("rent-preview")
          ? {
              data: { month: "2026-08", amount: 3000, occupiedDays: 31, daysInMonth: 31, isProrated: false },
              commission: {
                month: "2026-08",
                commissionAmount: 3000,
                sstRate: 0.08,
                sstAmount: 240,
                sstBearer: "kaen",
                total: 3240,
              },
            }
          : { data: [] },
      ) as never,
    );
    render(
      wrap(
        <OccupancyFields
          {...base}
          firstMonthIsCommission={true}
          commissionSstBearer="kaen"
        />,
      ),
    );
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        expect.stringContaining("firstMonthIsCommission=true"),
      ),
    );
    const [calledUrl] = vi.mocked(apiFetch).mock.calls.find((c) =>
      String(c[0]).includes("rent-preview"),
    )!;
    expect(String(calledUrl)).toContain("commissionSstBearer=kaen");
    expect(await screen.findByText(/KAEN commission/)).toBeTruthy();
  });

  it("checked + no-full-month response (commission: null): renders the 'No full month' note, not a commission line", async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("rent-preview")
          ? {
              data: { month: "2026-08", amount: 1500, occupiedDays: 15, daysInMonth: 31, isProrated: true },
              commission: null,
            }
          : { data: [] },
      ) as never,
    );
    render(
      wrap(
        <OccupancyFields
          {...base}
          moveInDate="2026-08-15"
          firstMonthIsCommission={true}
          commissionSstBearer="owner"
        />,
      ),
    );
    expect(
      await screen.findByText(/No full month in this tenancy — no commission\./),
    ).toBeTruthy();
    expect(screen.queryByText(/KAEN commission/)).not.toBeInTheDocument();
  });

  it("unchecked (regression): sends no firstMonthIsCommission param, no checkbox state, and no commission line renders", async () => {
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("rent-preview")
          ? { data: { month: "2026-08", amount: 3000, occupiedDays: 31, daysInMonth: 31, isProrated: false } }
          : { data: [] },
      ) as never,
    );
    render(wrap(<OccupancyFields {...base} />));
    await waitFor(() =>
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(expect.stringContaining("rent-preview")),
    );
    const [calledUrl] = vi.mocked(apiFetch).mock.calls.find((c) =>
      String(c[0]).includes("rent-preview"),
    )!;
    expect(String(calledUrl)).not.toContain("firstMonthIsCommission");
    expect(screen.queryByText(/KAEN commission/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No full month in this tenancy — no commission\./),
    ).not.toBeInTheDocument();
  });

  it("renders the checkbox unchecked by default and calls onFirstMonthIsCommissionChange(true) when checked", () => {
    const onFirstMonthIsCommissionChange = vi.fn();
    render(
      wrap(
        <OccupancyFields
          {...base}
          onFirstMonthIsCommissionChange={onFirstMonthIsCommissionChange}
        />,
      ),
    );
    const checkbox = screen.getByRole("checkbox", { name: /first month rent is kaen.s commission/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onFirstMonthIsCommissionChange).toHaveBeenCalledWith(true);
  });

  it("only renders the SST-bearer select when firstMonthIsCommission is true, and reports bearer changes", () => {
    const onCommissionSstBearerChange = vi.fn();
    const { rerender } = render(
      wrap(
        <OccupancyFields
          {...base}
          firstMonthIsCommission={false}
          onCommissionSstBearerChange={onCommissionSstBearerChange}
        />,
      ),
    );
    expect(screen.queryByLabelText(/sst bearer/i)).not.toBeInTheDocument();

    rerender(
      wrap(
        <OccupancyFields
          {...base}
          firstMonthIsCommission={true}
          commissionSstBearer="owner"
          onCommissionSstBearerChange={onCommissionSstBearerChange}
        />,
      ),
    );
    const select = screen.getByLabelText(/sst bearer/i);
    expect(select).toHaveValue("owner");
    fireEvent.change(select, { target: { value: "kaen" } });
    expect(onCommissionSstBearerChange).toHaveBeenCalledWith("kaen");
  });
});
