import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { usePortalAccessActions } from "../use-portal-access-actions";

function wrap(qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function makeQc() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
}

describe("usePortalAccessActions", () => {
  beforeEach(() => { apiFetch.mockReset().mockResolvedValue({}); });

  it("grant posts to the party portal-access endpoint", async () => {
    const { result } = renderHook(() => usePortalAccessActions("p1", "owner"), { wrapper: wrap() });
    result.current.grant.mutate({ email: "o@x.com", password: "Temp123", fullName: "O" });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/parties/p1/portal-access",
      expect.objectContaining({ method: "POST" }),
    ));
    const [, opts] = apiFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ email: "o@x.com", password: "Temp123", fullName: "O" });
  });

  it("revoke deletes with updatedAt", async () => {
    const { result } = renderHook(() => usePortalAccessActions("p1", "tenant"), { wrapper: wrap() });
    result.current.revoke.mutate({ updatedAt: "2026-01-01T00:00:00.000Z" });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/parties/p1/portal-access",
      expect.objectContaining({ method: "DELETE" }),
    ));
    const [, opts] = apiFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("reset posts to reset-portal-password with the password in the body", async () => {
    const { result } = renderHook(() => usePortalAccessActions("p1", "owner"), { wrapper: wrap() });
    result.current.reset.mutate({ password: "Temp123" });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/parties/p1/reset-portal-password",
      expect.objectContaining({ method: "POST" }),
    ));
    const [, opts] = apiFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ password: "Temp123" });
  });

  it("grant (owner) invalidates ['parties','owners','p1'] and ['owners'] on success", async () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => usePortalAccessActions("p1", "owner"), { wrapper: wrap(qc) });
    result.current.grant.mutate({ email: "o@x.com", password: "Temp123", fullName: "O" });
    await waitFor(() => expect(result.current.grant.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["parties", "owners", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["owners"] });
  });

  it("grant (tenant) invalidates ['parties','tenants','p1'] and ['tenants'] on success", async () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => usePortalAccessActions("p1", "tenant"), { wrapper: wrap(qc) });
    result.current.grant.mutate({ email: "t@x.com", password: "Temp123", fullName: "T" });
    await waitFor(() => expect(result.current.grant.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["parties", "tenants", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["tenants"] });
  });
});
