import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";

// Mirror the relevant slice of our routes — testing the actual router setup
// would require booting too much. This guards the rule, not the wiring.
//
// Domain note: this is the SALES-CLAIM domain. Different from the commission
// claims redirect at portal-claims-redirect.test.tsx — see
// .claude/docs/domain-glossary.md. Sales-claim filing now happens in the
// unified Pipeline at /portal/pipeline?tab=sales (Plan 2). The list page at
// /portal/sales-claims stays read-only.
function TestRouter({ initialEntries }: { initialEntries: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/portal/pipeline" element={<div data-testid="pipeline" />} />
        <Route path="/portal/sales-claims" element={<div data-testid="sales-claims-list" />} />
        <Route
          path="/portal/sales-claims/new"
          element={<Navigate to="/portal/pipeline?tab=sales" replace />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("/portal/sales-claims/new redirect", () => {
  it("redirects /portal/sales-claims/new to /portal/pipeline?tab=sales", () => {
    render(<TestRouter initialEntries={["/portal/sales-claims/new"]} />);
    expect(screen.getByTestId("pipeline")).toBeInTheDocument();
  });

  it("does NOT redirect /portal/sales-claims (list page stays)", () => {
    render(<TestRouter initialEntries={["/portal/sales-claims"]} />);
    expect(screen.getByTestId("sales-claims-list")).toBeInTheDocument();
  });
});
