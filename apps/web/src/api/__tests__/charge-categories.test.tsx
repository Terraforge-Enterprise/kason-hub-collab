import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  useChargeCategories,
  useDocumentSeries,
  useUpdateDocumentSeries,
} from "../charge-categories";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => apiFetch.mockReset());

describe("useChargeCategories", () => {
  it("GETs /charge-categories and unwraps items", async () => {
    apiFetch.mockResolvedValue({ items: [{ id: "c1", code: "rental" }] });
    const { result } = renderHook(() => useChargeCategories(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith("/charge-categories");
    expect(result.current.data?.items[0].code).toBe("rental");
  });

  it("appends includeInactive=true when asked; respects enabled:false", async () => {
    apiFetch.mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useChargeCategories({ includeInactive: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith("/charge-categories?includeInactive=true");

    apiFetch.mockClear();
    renderHook(() => useChargeCategories({ enabled: false }), { wrapper });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("useDocumentSeries / useUpdateDocumentSeries", () => {
  it("GETs /charge-categories/series", async () => {
    apiFetch.mockResolvedValue({ items: [{ id: "s1", code: "DEP" }] });
    const { result } = renderHook(() => useDocumentSeries(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith("/charge-categories/series");
  });

  it("PATCHes /charge-categories/series/:id with the token in the body", async () => {
    apiFetch.mockResolvedValue({ data: { id: "s1" } });
    const { result } = renderHook(() => useUpdateDocumentSeries(), { wrapper });
    await result.current.mutateAsync({ id: "s1", prefix: "INV", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" });
    expect(apiFetch).toHaveBeenCalledWith("/charge-categories/series/s1", {
      method: "PATCH",
      body: JSON.stringify({ prefix: "INV", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }),
    });
  });
});
