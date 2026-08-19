import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  API_BASE: "",
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from "@/lib/api-client";
import { useBillingReadiness } from "../owner-billing";

const apiFetchMock = vi.mocked(apiFetch);

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => vi.clearAllMocks());

describe("useBillingReadiness", () => {
  it("fetches the readiness endpoint for a given apartmentId", async () => {
    apiFetchMock.mockResolvedValue({ data: { ownerAssigned: true, hasActiveConfig: false, ownerPartyId: "o1" } } as never);
    const { result } = renderHook(() => useBillingReadiness("apt-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith("/owner-billing/units/apt-1/billing-readiness");
    expect(result.current.data?.data.hasActiveConfig).toBe(false);
  });

  it("is disabled (never fetches) when apartmentId is null", () => {
    renderHook(() => useBillingReadiness(null), { wrapper: wrapper() });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
