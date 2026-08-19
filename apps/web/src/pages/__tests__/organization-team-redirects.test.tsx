import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";

// Mirror the Team-hub redirect slice of router.tsx (same approach as
// parties-agents-redirect.test.tsx) — the retired Managers + Admin pages and the
// /organization landing all resolve to the unified Staff register, and the
// sibling Agents/Hierarchy routes are NOT swallowed by the bare /organization
// redirect. Kept in lockstep with the routes in router.tsx.
function TestRouter({ initialEntries }: { initialEntries: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/organization/staff" element={<div data-testid="staff" />} />
        <Route path="/organization/hierarchy" element={<div data-testid="hierarchy" />} />
        <Route path="/organization/agents" element={<div data-testid="agents" />} />
        <Route path="/organization" element={<Navigate to="/organization/staff" replace />} />
        <Route path="/organization/managers" element={<Navigate to="/organization/staff" replace />} />
        <Route path="/organization/admins" element={<Navigate to="/organization/staff" replace />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Team hub redirects (Managers/Admin → Staff)", () => {
  it.each([["/organization"], ["/organization/managers"], ["/organization/admins"]])(
    "%s redirects to /organization/staff",
    (from) => {
      render(<TestRouter initialEntries={[from]} />);
      expect(screen.getByTestId("staff")).toBeInTheDocument();
    },
  );

  it("does not swallow the sibling Agents route", () => {
    render(<TestRouter initialEntries={["/organization/agents"]} />);
    expect(screen.getByTestId("agents")).toBeInTheDocument();
  });

  it("does not swallow the sibling Hierarchy route", () => {
    render(<TestRouter initialEntries={["/organization/hierarchy"]} />);
    expect(screen.getByTestId("hierarchy")).toBeInTheDocument();
  });
});
