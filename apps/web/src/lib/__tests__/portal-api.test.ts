import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portalApiFetch, portalApiUrl } from "../portal-api";

describe("portalApiFetch", () => {
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

  it("builds URLs from the configured portal base", () => {
    expect(portalApiUrl("/profile")).toBe("/portal-api/profile");
  });

  it("redirects to portal login on unauthorized by default", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
    });

    await expect(portalApiFetch("/profile")).rejects.toMatchObject({ status: 401 });
    expect(locationHref).toBe("/portal/login");
  });

  it("lets callers handle unauthorized responses locally when requested", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Invalid credentials" }),
    });

    await expect(
      portalApiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com", password: "badpass" }),
        redirectOnUnauthorized: false,
      }),
    ).rejects.toMatchObject({ message: "Invalid credentials", status: 401 });
    expect(locationHref).toBe("");
  });
});
