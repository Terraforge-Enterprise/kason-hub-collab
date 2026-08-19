import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Task 4 (tenant-portal-redesign, Appendix A §2 My Tenancy) — replaces the old
// six-field <PortalLeasePage> (lease.tsx) with a Tenancy Summary / Occupants /
// Property Management card layout on the design-standard shell.
//
// NOTE: jest-dom matchers are NOT functional under the worktree vitest env
// (dual-package hazard — setup.ts imports jest-dom but expect.extend lands on
// a different `expect` instance), so this file uses NATIVE matchers only:
// getByText/getByRole throw when absent (so reaching an assertion after them
// proves presence); toBeTruthy/toBeNull assert presence/absence explicitly.
// Same pattern as payments.test.tsx / pay.test.tsx / combined-statement.test.tsx.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  PortalApiError: class PortalApiError extends Error {},
}));

// usePortalProfile is a fallback name source only (dashboard tenant.displayName
// is the primary, always-present source per the schema) — mocked per the
// profile.test.tsx convention so the hook doesn't hit a real query.
vi.mock("@/components/portal-protected-route", () => ({
  usePortalProfile: vi.fn(() => ({
    data: { data: { fullName: "Rajesh Kumar" } },
    isLoading: false,
  })),
}));

import PortalMyTenancyPage from "../my-tenancy";

const LEASE_FIXTURE = {
  data: {
    tenant: { displayName: "Rajesh Kumar", partyType: "tenant" },
    lease: {
      tenancyCode: "TEN-2025-003",
      unitCode: "A-08-02",
      propertyName: "Seri Kembangan Heights",
      startDate: "2025-12-01",
      endDate: "2026-12-01",
      monthlyRentAmount: 1200,
      status: "active",
    },
    upcomingCharges: [],
    recentPayments: [],
    announcements: [],
    balance: { totalCharges: 0, totalPayments: 0, totalCredits: 0, netBalance: 0, currency: "MYR" },
  },
};

// Open-ended lease (endDate: null) — the schema allows this; must render
// "Open-ended" rather than a fabricated end date.
const OPEN_ENDED_LEASE_FIXTURE = {
  data: {
    ...LEASE_FIXTURE.data,
    lease: { ...LEASE_FIXTURE.data.lease, endDate: null },
  },
};

const NO_LEASE_FIXTURE = {
  data: {
    tenant: { displayName: "Rajesh Kumar", partyType: "tenant" },
    lease: null,
    upcomingCharges: [],
    recentPayments: [],
    announcements: [],
    balance: { totalCharges: 0, totalPayments: 0, totalCredits: 0, netBalance: 0, currency: "MYR" },
  },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/my-tenancy"]}>
        <PortalMyTenancyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
});

describe("PortalMyTenancyPage — page header", () => {
  it("renders the FileText-icon header with the design-standard subtitle", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();
    expect(await screen.findByText("My Tenancy")).toBeTruthy();
    expect(screen.getByText("Details about your rental and agreement.")).toBeTruthy();
  });
});

describe("PortalMyTenancyPage — tenancy summary", () => {
  it("renders tenancy summary: code, property, unit, RM 1,200.00, lease period, status badge", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();

    expect(await screen.findByText("TEN-2025-003")).toBeTruthy();
    expect(screen.getByText("Seri Kembangan Heights")).toBeTruthy();
    expect(screen.getByText("A-08-02")).toBeTruthy();
    expect(screen.getByText("RM 1,200.00")).toBeTruthy();
    expect(screen.getByText("1 Dec 2025 – 1 Dec 2026")).toBeTruthy();
    // Status Badge renders the raw lease.status string (dashboard.tsx precedent).
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("open-ended lease (endDate: null) renders 'Open-ended', never a fabricated date", async () => {
    portalApiFetch.mockResolvedValue(OPEN_ENDED_LEASE_FIXTURE);
    renderPage();

    expect(await screen.findByText("TEN-2025-003")).toBeTruthy();
    expect(screen.getByText("1 Dec 2025 – Open-ended")).toBeTruthy();
  });

  it("does NOT render out-of-scope fields absent from the API (deposit, rent-due-day, renewal)", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();
    await screen.findByText("TEN-2025-003");

    expect(screen.queryByText(/deposit/i)).toBeNull();
    expect(screen.queryByText(/renewal/i)).toBeNull();
    expect(screen.queryByText(/rent due/i)).toBeNull();
    expect(screen.queryByText(/^1st of every month$/i)).toBeNull();
  });
});

describe("PortalMyTenancyPage — occupants + property management", () => {
  it("renders the Occupants card with the main tenant name and a 'Main tenant' badge", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();
    await screen.findByText("TEN-2025-003");

    expect(screen.getByText("Rajesh Kumar")).toBeTruthy();
    expect(screen.getByText("Main tenant")).toBeTruthy();
  });

  it("renders the Property Management card with the static KAEN Properties block", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();
    await screen.findByText("TEN-2025-003");

    expect(screen.getByText("KAEN Properties")).toBeTruthy();
  });
});

describe("PortalMyTenancyPage — action buttons", () => {
  it("'View tenancy agreement' links to /portal/documents", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();
    await screen.findByText("TEN-2025-003");

    const link = screen.getByRole("link", { name: /view tenancy agreement/i });
    expect(link.getAttribute("href")).toBe("/portal/documents");
  });

  it("renders a 'Contact management' action (no fabricated phone/email)", async () => {
    portalApiFetch.mockResolvedValue(LEASE_FIXTURE);
    renderPage();
    await screen.findByText("TEN-2025-003");

    expect(screen.getByText(/contact management/i)).toBeTruthy();
    // Never invent a support channel that doesn't exist elsewhere in the app.
    expect(screen.queryByText(/\+60/)).toBeNull();
    expect(screen.queryByText(/@example\.com/i)).toBeNull();
  });
});

describe("PortalMyTenancyPage — no lease", () => {
  it("no lease -> shows the 'No active tenancy' EmptyState, no crash", async () => {
    portalApiFetch.mockResolvedValue(NO_LEASE_FIXTURE);
    renderPage();

    expect(await screen.findByText("No active tenancy")).toBeTruthy();
    expect(screen.getByText("You have no active lease on record.")).toBeTruthy();

    // The lease-derived sections must not render at all.
    expect(screen.queryByText("TEN-2025-003")).toBeNull();
    expect(screen.queryByText("Main tenant")).toBeNull();
    expect(screen.queryByRole("link", { name: /view tenancy agreement/i })).toBeNull();
  });
});
