import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// --- Mocks ------------------------------------------------------------
// usePortalProfile is reconfigured per test via mockUsePortalProfile.mockReturnValue(...).
vi.mock("@/components/portal-protected-route", () => ({
  usePortalProfile: vi.fn(),
}));

// The dispatcher lazily imports these three dashboards. Replace each with an
// identifiable stub so we can assert which one (if any) actually mounted.
vi.mock("../dashboard", () => ({
  default: () => <div data-testid="tenant-dashboard-stub">tenant dashboard</div>,
}));
vi.mock("../agent-home", () => ({
  default: () => <div data-testid="agent-home-stub">agent home</div>,
}));
vi.mock("../owner-dashboard", () => ({
  default: () => <div data-testid="owner-dashboard-stub">owner dashboard</div>,
}));

import { usePortalProfile } from "@/components/portal-protected-route";
import PortalDashboardDispatcher from "../dashboard-dispatcher";

const mockUsePortalProfile = vi.mocked(usePortalProfile);

const EMPTY_STATE_TITLE = "Nothing linked to your account yet";

type ProfileFixture = {
  userType: string;
  propertyCount?: number;
  tenancyCode?: string | null;
};

/** Simulates the shape usePortalProfile() returns from react-query. */
function mockProfile(data: ProfileFixture | undefined, isLoading = false) {
  mockUsePortalProfile.mockReturnValue({
    data: data ? { data } : undefined,
    isLoading,
    error: null,
  } as unknown as ReturnType<typeof usePortalProfile>);
}

describe("PortalDashboardDispatcher", () => {
  it("owner zero properties shows empty state", async () => {
    mockProfile({ userType: "owner", propertyCount: 0 });
    render(<PortalDashboardDispatcher />);

    expect(await screen.findByText(EMPTY_STATE_TITLE)).toBeInTheDocument();
    expect(screen.queryByTestId("owner-dashboard-stub")).not.toBeInTheDocument();
  });

  it("owner with properties renders dashboard", async () => {
    mockProfile({ userType: "owner", propertyCount: 2 });
    render(<PortalDashboardDispatcher />);

    expect(await screen.findByTestId("owner-dashboard-stub")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE_TITLE)).not.toBeInTheDocument();
  });

  it("tenant no tenancy shows empty state", async () => {
    mockProfile({ userType: "tenant", tenancyCode: null });
    render(<PortalDashboardDispatcher />);

    expect(await screen.findByText(EMPTY_STATE_TITLE)).toBeInTheDocument();
    expect(screen.queryByTestId("tenant-dashboard-stub")).not.toBeInTheDocument();
  });

  it("tenant with tenancy code renders dashboard", async () => {
    mockProfile({ userType: "tenant", tenancyCode: "T-1" });
    render(<PortalDashboardDispatcher />);

    expect(await screen.findByTestId("tenant-dashboard-stub")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE_TITLE)).not.toBeInTheDocument();
  });

  it("agent renders agent home and never shows the empty state", async () => {
    mockProfile({ userType: "agent" });
    render(<PortalDashboardDispatcher />);

    expect(await screen.findByTestId("agent-home-stub")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE_TITLE)).not.toBeInTheDocument();
  });

  it("does not show the empty state while the profile is still loading", () => {
    // data is undefined during the react-query loading window (before the
    // profile resolves). PortalProtectedRoute blocks rendering the dispatcher
    // until data loads in production, but this guards the dispatcher itself
    // in case it is ever reached with data still undefined.
    mockProfile(undefined, true);
    render(<PortalDashboardDispatcher />);

    expect(screen.queryByText(EMPTY_STATE_TITLE)).not.toBeInTheDocument();
  });
});
