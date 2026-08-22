import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PortalTeamPage from "../portal-team-page";

// The page makes two distinct calls — branch the mock on the path so we can
// exercise the unified org-chart: org → upline → YOU → downline subtree.
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: vi.fn(async (path: string) => {
    if (path === "/team/upline-chain") {
      return {
        data: {
          organization: { id: "org-1", name: "KAEN PROPERTIES MANAGEMENT SDN BHD" },
          // Farah reports straight to the org → self-only chain (isAtTop).
          chain: [
            {
              id: "farah",
              displayName: "Farah binti Hassan",
              agentLevel: "leader",
              isSelf: true,
            },
          ],
        },
      };
    }
    if (path === "/team/downlines") {
      return {
        data: {
          downlines: [
            {
              id: "rizal",
              displayName: "Ahmad Rizal bin Zainal",
              agentLevel: "new_agent",
              primaryEmail: "rizal.zainal@gmail.com",
              primaryPhone: "+60142345678",
              uplineId: "farah",
              depth: 1,
            },
            {
              id: "priya",
              displayName: "Priya a/p Subramaniam",
              agentLevel: "pre_leader",
              primaryEmail: "priya.subra@gmail.com",
              primaryPhone: "+60152345678",
              uplineId: "farah",
              depth: 1,
            },
          ],
        },
      };
    }
    throw new Error(`unexpected path: ${path}`);
  }),
}));

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe("Portal /portal/team — unified reporting line + team", () => {
  it("renders the caller's downline beneath the YOU node (not a 'top of hierarchy' dead-end)", async () => {
    render(wrap(<PortalTeamPage />));

    // Self node is present and flagged as YOU.
    await waitFor(() => screen.getByText("Farah binti Hassan"));
    expect(screen.getByText("YOU")).toBeInTheDocument();

    // The team flows INTO the same chart — direct reports are visible with
    // their contact info (the whole point of the unified view).
    expect(await screen.findByText("Ahmad Rizal bin Zainal")).toBeInTheDocument();
    expect(screen.getByText("Priya a/p Subramaniam")).toBeInTheDocument();
    expect(screen.getByText("rizal.zainal@gmail.com")).toBeInTheDocument();

    // Team summary caption reflects the real counts.
    expect(
      screen.getByText(/2 agents · 2 direct reports/i),
    ).toBeInTheDocument();
  });

  it("does NOT claim the caller is at the top of the hierarchy when they have a team", async () => {
    render(wrap(<PortalTeamPage />));
    await screen.findByText("Ahmad Rizal bin Zainal");

    // The old contradictory copy must be gone for someone who has reports.
    // (The org-root card still says "Top of the hierarchy" about the ORG —
    // that's correct; what must vanish is the claim about the CALLER.)
    expect(
      screen.queryByText(/you are at the top of the hierarchy/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/you report directly to .* and no agents report to you/i),
    ).not.toBeInTheDocument();
  });
});
