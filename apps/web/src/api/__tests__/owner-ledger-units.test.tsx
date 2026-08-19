// P4 Task 5: useOrgUnitsSummary / useApartmentContext URL construction + enabling.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
import { useOrgUnitsSummary, useApartmentContext } from "../owner-ledger";

const apiFetchMock = vi.mocked(apiFetch);

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({ data: { items: [], total: 0 } } as never);
});

describe("useOrgUnitsSummary (P4)", () => {
  it("hits /owner-ledger/units-summary with month + defaults", async () => {
    renderHook(() => useOrgUnitsSummary({ month: "2026-07-01", page: 1, pageSize: 20 }), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const url = String(apiFetchMock.mock.calls[0]![0]);
    expect(url.startsWith("/owner-ledger/units-summary?")).toBe(true);
    expect(url).toContain("month=2026-07-01");
    expect(url).toContain("page=1");
    expect(url).toContain("pageSize=20");
  });

  it("forwards q and propertyId, drops empty strings", async () => {
    renderHook(
      () => useOrgUnitsSummary({ month: "2026-07-01", q: "A-10", propertyId: "", page: 2, pageSize: 20 }),
      { wrapper },
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const url = String(apiFetchMock.mock.calls[0]![0]);
    expect(url).toContain("q=A-10");
    expect(url).not.toContain("propertyId");
    expect(url).toContain("page=2");
  });

  it("stays disabled without a month", async () => {
    renderHook(() => useOrgUnitsSummary({ month: "" }), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe("useApartmentContext (P4)", () => {
  it("hits /owner-ledger/units/:id/context", async () => {
    apiFetchMock.mockResolvedValue({ data: { apartmentId: "apt-1" } } as never);
    renderHook(() => useApartmentContext("apt-1"), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/owner-ledger/units/apt-1/context"));
  });

  it("stays disabled without an apartmentId", async () => {
    renderHook(() => useApartmentContext(undefined), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
