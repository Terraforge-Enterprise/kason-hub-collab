// Settings → Charge Categories is now a REDIRECT (2026-08-03): the table moved into
// Billing Config as a panel. The behavioural tests that used to live here moved with it
// to charge-categories-panel.test.tsx; what remains is the redirect contract, because a
// silently-broken redirect is how a bookmarked settings URL turns into a dead page.
//
// The flag fallback is covered too: this route is gated on ENABLE_PHASE2_BILLING_DOCS
// while Billing Config is gated on ENABLE_PHASE2_AUTODRAFT, so in the BILLING_DOCS-on /
// AUTODRAFT-off combination redirecting would bounce to an unregistered route — the page
// renders the panel in place instead.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("@/api/charge-categories", () => ({
  useChargeCategories: () => ({ data: { items: [] }, isLoading: false, isError: false }),
  useDocumentSeries: () => ({ data: { items: [] }, isLoading: false, isError: false }),
  useCreateChargeCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateChargeCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeactivateChargeCategory: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

import ChargeCategoriesSettingsPage from "../charge-categories-section";

const AUTODRAFT_FLAG = "VITE_ENABLE_PHASE2_AUTODRAFT";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/settings/charge-categories"]}>
      <Routes>
        <Route path="/settings/charge-categories" element={<ChargeCategoriesSettingsPage />} />
        <Route path="/settings/billing-config" element={<div>BILLING CONFIG PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("ChargeCategoriesSettingsPage (redirect)", () => {
  it("redirects to Billing Config when that page exists", () => {
    vi.stubEnv(AUTODRAFT_FLAG, "true");
    renderAt();
    expect(screen.getByText("BILLING CONFIG PAGE")).toBeTruthy();
  });

  it("renders the panel in place when Billing Config is flag-dark, rather than bouncing to a dead route", () => {
    vi.stubEnv(AUTODRAFT_FLAG, "");
    renderAt();
    expect(screen.queryByText("BILLING CONFIG PAGE")).toBeNull();
    expect(screen.getByText("Charge categories")).toBeTruthy();
  });
});
