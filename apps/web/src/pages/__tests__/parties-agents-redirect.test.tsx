import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate, useParams } from "react-router-dom";

// Mirror the relevant slice of router.tsx — tests the redirect rule without
// booting the full router stack with auth/layout guards.
//
// Domain: /parties/agents* are legacy URLs that redirect to /organization/agents*
// per spec §4a. Physical files (AgentsPage, AgentDetailPage) are unchanged.

function AgentDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/organization/agents/${id}`} replace />;
}

function TestRouter({ initialEntries }: { initialEntries: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/organization/agents" element={<div data-testid="agents-list" />} />
        <Route path="/organization/agents/:id" element={<div data-testid="agent-detail" />} />
        <Route path="/parties/agents" element={<Navigate to="/organization/agents" replace />} />
        <Route path="/parties/agents/:id" element={<AgentDetailRedirect />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("/parties/agents → /organization/agents redirects", () => {
  it("redirects /parties/agents to /organization/agents", () => {
    render(<TestRouter initialEntries={["/parties/agents"]} />);
    expect(screen.getByTestId("agents-list")).toBeInTheDocument();
  });

  it("redirects /parties/agents/:id to /organization/agents/:id", () => {
    render(<TestRouter initialEntries={["/parties/agents/abc-123"]} />);
    expect(screen.getByTestId("agent-detail")).toBeInTheDocument();
  });
});
