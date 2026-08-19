import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AgentHomePage from "../index";
import * as api from "@/api/portal-agent-home";

vi.mock("@/api/portal-agent-home");

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MemoryRouter><QueryClientProvider client={qc}>{ui}</QueryClientProvider></MemoryRouter>;
}

const baseSummary: api.AgentHomeSummary = {
  pendingActions: [
    { domain: "pipeline", id: "u1", label: "Sales unit A-1 — needs_amendment", href: "/portal/sales-pipeline?unit=u1", updatedAt: "2026-04-29T10:00:00Z" },
  ],
  pipeline: { counts: { needs_amendment: 1, approved: 2 } },
  salesClaims: { counts: { submitted: 1 }, approvedThisMonth: 1500 },
  renovationClaims: { counts: { approved: 1 }, approvedThisMonth: 800 },
  commission: { earnedThisMonth: 1234, submittedPending: 567 },
  recentActivity: [
    { domain: "pipeline", id: "u1", label: "Sales unit A-1 — needs_amendment", href: "/portal/sales-pipeline?unit=u1", updatedAt: "2026-04-29T10:00:00Z" },
  ],
  errors: [],
};

describe("AgentHomePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders all four domain cards plus pending actions and recent activity", async () => {
    vi.mocked(api.fetchAgentHomeSummary).mockResolvedValue(baseSummary);
    render(withProviders(<AgentHomePage />));

    await waitFor(() => expect(screen.getByText(/Pending action \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText("Pipeline")).toBeInTheDocument();
    expect(screen.getByText("Sales Claims")).toBeInTheDocument();
    expect(screen.getByText("Renovation Claims")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
    expect(screen.getByText(/Recent activity/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Commission Analytics/i })).toHaveAttribute("href", "/portal/commissions/dashboard");
  });

  it("renders the unavailable state for a failed slice without blanking the page", async () => {
    vi.mocked(api.fetchAgentHomeSummary).mockResolvedValue({
      ...baseSummary,
      pipeline: null,
      errors: ["pipeline"],
    });
    render(withProviders(<AgentHomePage />));
    await waitFor(() => expect(screen.getByText("Sales Claims")).toBeInTheDocument());
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
  });

  it("shows a page-level retry on hard failure", async () => {
    vi.mocked(api.fetchAgentHomeSummary).mockRejectedValue(new Error("boom"));
    render(withProviders(<AgentHomePage />));
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument());
  });
});
