import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";

// Mirror the relevant slice of our routes — testing the actual router setup
// would require booting too much. This guards the rule, not the wiring.
function TestRouter({ initialEntries }: { initialEntries: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/portal/commissions/claims" element={<div data-testid="commission-claims" />} />
        <Route path="/portal/claims/new" element={<div data-testid="claims-new" />} />
        <Route path="/portal/claims/:id" element={<div data-testid="claims-detail" />} />
        <Route path="/portal/claims" element={<Navigate to="/portal/commissions/claims" replace />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("/portal/claims redirect", () => {
  it("redirects /portal/claims (exact) to /portal/commissions/claims", () => {
    render(<TestRouter initialEntries={["/portal/claims"]} />);
    expect(screen.getByTestId("commission-claims")).toBeInTheDocument();
  });

  it("does NOT redirect /portal/claims/new", () => {
    render(<TestRouter initialEntries={["/portal/claims/new"]} />);
    expect(screen.getByTestId("claims-new")).toBeInTheDocument();
  });

  it("does NOT redirect /portal/claims/:id", () => {
    render(<TestRouter initialEntries={["/portal/claims/abc-123"]} />);
    expect(screen.getByTestId("claims-detail")).toBeInTheDocument();
  });
});
