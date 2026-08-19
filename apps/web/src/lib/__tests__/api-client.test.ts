import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock auth module — Phase 2 uses getStoredUser (not getStoredToken)
vi.mock("../auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { clearStoredAuth } from "../auth";
import { apiFetch, ApiError } from "../api-client";

describe("apiFetch", () => {
  const originalFetch = globalThis.fetch;
  let locationHref = "";

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    locationHref = "";
    Object.defineProperty(window, "location", {
      value: { get href() { return locationHref; }, set href(v: string) { locationHref = v; } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends credentials: include (cookie-based auth)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: "ok" }),
    });

    await apiFetch("/test");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/test"),
      expect.objectContaining({
        credentials: "include",
      }),
    );
  });

  it("returns parsed JSON on success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 1, name: "test" }),
    });

    const result = await apiFetch("/test");
    expect(result).toEqual({ id: 1, name: "test" });
  });

  it("redirects to /login on 401 when previously authenticated", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
    });

    await expect(apiFetch("/test")).rejects.toThrow("Session expired");
    expect(clearStoredAuth).toHaveBeenCalled();
    expect(locationHref).toBe("/login");
  });

  it("throws on non-OK response with error message", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
    });

    await expect(apiFetch("/test")).rejects.toThrow("Server error");
  });

  it("throws ApiError with status for status-based handling", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: "Conflict" }),
    });

    let caught: unknown;
    try {
      await apiFetch("/test");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).message).toBe("Conflict");
  });

  it("ApiError carries optional code field", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: "Invalid", code: "VALIDATION_FAILED" }),
    });

    let caught: unknown;
    try {
      await apiFetch("/test");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe("VALIDATION_FAILED");
    expect((caught as ApiError).status).toBe(422);
  });
});
