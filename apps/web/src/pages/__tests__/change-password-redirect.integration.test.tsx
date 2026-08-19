import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChangePasswordPage from "../change-password-page";
import { AdminMustChangeGuard } from "@/components/admin-must-change-guard";
import { adminSessionKey } from "@/api/admin-auth";

// Regression test for the first-login "stuck on change-password" bug.
//
// Mirrors the REAL router structure (router.tsx): /change-password is OUTSIDE
// AdminMustChangeGuard; only /dashboard is INSIDE it. So while the user is on
// the change-password page nothing observes the admin-session query — the change
// mutation's invalidateQueries(adminSessionKey) therefore does NOT refetch
// (refetchType 'active', no observer) and the cache keeps mustChangePassword=true.
// Before the fix, navigate('/dashboard') mounted the guard, which read that STALE
// cache and bounced back to /change-password → stuck.
//
// The fix signs the user out and returns them to /login (unguarded), matching the
// intended first-login "re-login with your new password" flow.
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ clearAuth: vi.fn() }) }));
import { apiFetch } from "@/lib/api-client";

function setup() {
  let mustChange = true;
  const session = () => ({
    userId: "u1", userType: "admin", partyId: "p1", orgId: "o1", role: "admin",
    mustChangePassword: mustChange,
  });
  vi.mocked(apiFetch).mockImplementation(((url: string) => {
    if (typeof url === "string" && url.includes("change-password")) {
      mustChange = false; // backend clears the flag on change (verified in auth.service.ts)
      return Promise.resolve({ ok: true, message: "ok" });
    }
    return Promise.resolve(session()); // /auth/me, /auth/logout, etc.
  }) as never);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Post-login state: the session was already fetched as must-change and cached.
  qc.setQueryData(adminSessionKey, session());

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/change-password"]}>
        <Routes>
          {/* OUTSIDE the guard, exactly like router.tsx */}
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/login" element={<div>LOGIN PAGE</div>} />
          {/* INSIDE the guard */}
          <Route
            path="/dashboard"
            element={
              <AdminMustChangeGuard>
                <div>DASHBOARD CONTENT</div>
              </AdminMustChangeGuard>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("first-login change-password redirect (admin) — must not get stuck", () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it("signs out to the login page after a successful first-login change (not stuck)", async () => {
    setup();
    expect(screen.getByText(/set a new password/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "old-temp" } });
    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: "newpass1" } });
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: "newpass1" } });
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    // Must leave the change-password page and land on /login.
    await waitFor(() => {
      expect(screen.getByText(/LOGIN PAGE/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/set a new password/i)).toBeNull();
  });
});
