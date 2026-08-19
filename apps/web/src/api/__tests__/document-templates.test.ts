// uploadTemplateLogo — request-shape tests.
// Regression: the logo upload used a raw fetch (FormData needs the browser to
// set its own multipart boundary, so it can't go through apiFetch) but forgot
// to attach the Authorization: Bearer token that every other admin call sends.
// On the cross-origin UAT deploy (CloudFront SPA → Lightsail API) the session
// cookie is dropped, so the request arrived with no credentials → 401 even as
// admin. These tests pin the bearer attachment while preserving the raw-fetch
// rationale (no forced JSON Content-Type, cookie fallback intact).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Auth mock (required by the api-client import chain) ──────────────────────
vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { getAdminToken } from "@/lib/auth";
import { uploadTemplateLogo } from "../document-templates";

const mockGetAdminToken = getAdminToken as ReturnType<typeof vi.fn>;

function okUploadResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { storageKey: "logos/x.png" } }),
  };
}

function lastFetchInit(): RequestInit {
  const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return mock.mock.calls[mock.mock.calls.length - 1][1] as RequestInit;
}

function headerBag(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("uploadTemplateLogo", () => {
  const originalFetch = globalThis.fetch;
  const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(okUploadResponse());
    mockGetAdminToken.mockReturnValue(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("attaches bearer token when present", async () => {
    mockGetAdminToken.mockReturnValue("tok-123");

    await uploadTemplateLogo("invoice", file);

    expect(headerBag(lastFetchInit()).Authorization).toBe("Bearer tok-123");
  });

  it("omits auth header when no token", async () => {
    mockGetAdminToken.mockReturnValue(null);

    await uploadTemplateLogo("invoice", file);

    expect(headerBag(lastFetchInit()).Authorization).toBeUndefined();
  });

  it("keeps credentials include (cookie fallback)", async () => {
    await uploadTemplateLogo("invoice", file);

    expect(lastFetchInit().credentials).toBe("include");
  });

  it("does not force a JSON Content-Type (FormData sets its own boundary)", async () => {
    mockGetAdminToken.mockReturnValue("tok-123");

    await uploadTemplateLogo("invoice", file);

    expect(headerBag(lastFetchInit())["Content-Type"]).toBeUndefined();
  });
});
