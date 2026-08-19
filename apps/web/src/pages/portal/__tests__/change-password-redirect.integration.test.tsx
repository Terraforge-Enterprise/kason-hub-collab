import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PortalChangePasswordPage from "../change-password-page";
import { PortalMustChangeGuard } from "@/components/portal-must-change-guard";
import { portalSessionKey } from "@/api/portal-auth";

// Portal counterpart of the first-login "stuck on change-password" regression.
// /portal/change-password sits OUTSIDE the PortalMustChangeGuard, so the session
// query is unobserved there: the mutation's invalidate marks it stale but never
// refetches, and the guard then reads the still-cached mustChangePassword=true
// and bounces straight back to this page.
//
// The old fix was to sign out to /portal/login. That worked but cost the tenant
// a re-login at the worst point in the funnel, so the page now REFETCHES the
// session before navigating and carries the user into the portal. These tests
// pin both halves: it lands on the dashboard, AND the guard doesn't bounce it.
vi.mock("@/lib/portal-api", () => ({ portalApiFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ clearStoredAuth: vi.fn(), setPortalToken: vi.fn() }));
import { portalApiFetch } from "@/lib/portal-api";

function setup(opts?: { seedSessionCache?: boolean }) {
  let mustChange = true;
  const session = () => ({
    userId: "u1", userType: "owner", partyId: "p1", orgId: "o1",
    mustChangePassword: mustChange,
  });
  vi.mocked(portalApiFetch).mockImplementation(((url: string) => {
    if (typeof url === "string" && url.includes("change-password")) {
      mustChange = false;
      return Promise.resolve({ ok: true, message: "ok", token: "fresh-token" });
    }
    return Promise.resolve({ data: session() }); // /auth/me (wrapped)
  }) as never);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Normally the guard has already populated this cache by redirecting the user
  // here. Landing on this URL directly (bookmark, refresh) leaves it empty.
  if (opts?.seedSessionCache ?? true) qc.setQueryData(portalSessionKey, session());

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/change-password"]}>
        <Routes>
          <Route path="/portal/change-password" element={<PortalChangePasswordPage />} />
          <Route path="/portal/login" element={<div>PORTAL LOGIN PAGE</div>} />
          <Route
            path="/portal/dashboard"
            element={
              <PortalMustChangeGuard>
                <div>PORTAL DASHBOARD</div>
              </PortalMustChangeGuard>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function submitNewPassword() {
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "old-temp" } });
  fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: "newpass1" } });
  fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: "newpass1" } });
  fireEvent.click(screen.getByRole("button", { name: /change password/i }));
}

describe("first-login change-password redirect (portal) — must not get stuck", () => {
  beforeEach(() => vi.mocked(portalApiFetch).mockReset());

  it("carries the user into the portal after a successful first-login change", async () => {
    setup();
    expect(screen.getByText(/set a new password/i)).toBeInTheDocument();

    submitNewPassword();

    await waitFor(() => {
      expect(screen.getByText(/PORTAL DASHBOARD/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/set a new password/i)).toBeNull();
    expect(screen.queryByText(/PORTAL LOGIN PAGE/i)).toBeNull();
  });

  it("does not sign the user out", async () => {
    setup();
    submitNewPassword();

    await waitFor(() => {
      expect(screen.getByText(/PORTAL DASHBOARD/i)).toBeInTheDocument();
    });
    const calledPaths = vi.mocked(portalApiFetch).mock.calls.map((c) => c[0]);
    expect(calledPaths).not.toContain("/auth/logout");
  });

  it("stays on the dashboard — the guard cannot bounce it back", async () => {
    // The regression this file exists for: the guard reads the cache the moment
    // the dashboard route mounts. If the page navigates while the cached session
    // still says mustChangePassword=true, the guard redirects straight back and
    // the tenant is stuck in a loop. Arriving is not enough — it has to STAY.
    setup();
    submitNewPassword();

    await waitFor(() => {
      expect(screen.getByText(/PORTAL DASHBOARD/i)).toBeInTheDocument();
    });

    // Let the guard re-render (and any background session refetch settle); it
    // must not redirect.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/PORTAL DASHBOARD/i)).toBeInTheDocument();
    expect(screen.queryByText(/set a new password/i)).toBeNull();
  });

  it("lands on the dashboard even with no cached session to patch", async () => {
    // Reached this URL directly, so there is nothing in the cache to write
    // mustChangePassword=false into. The guard must fall through to a real
    // /auth/me fetch — which by then returns false — rather than bouncing.
    setup({ seedSessionCache: false });
    submitNewPassword();

    await waitFor(() => {
      expect(screen.getByText(/PORTAL DASHBOARD/i)).toBeInTheDocument();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/PORTAL DASHBOARD/i)).toBeInTheDocument();
  });
});
