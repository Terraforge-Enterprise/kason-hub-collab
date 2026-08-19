import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import AuditLayout from "./audit-layout";

describe("AuditLayout", () => {
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/audit" element={<AuditLayout />}>
            <Route path="deals" element={<div>Deals content</div>} />
            <Route path="log" element={<div>Log content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders both tab labels", () => {
    renderAt("/audit/deals");
    expect(screen.getByRole("link", { name: "Deal Audit" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit Log" })).toBeInTheDocument();
  });

  it("marks the Deal Audit tab active on /audit/deals", () => {
    renderAt("/audit/deals");
    const dealsTab = screen.getByRole("link", { name: "Deal Audit" });
    expect(dealsTab).toHaveAttribute("aria-current", "page");
  });

  it("marks the Audit Log tab active on /audit/log", () => {
    renderAt("/audit/log");
    const logTab = screen.getByRole("link", { name: "Audit Log" });
    expect(logTab).toHaveAttribute("aria-current", "page");
  });

  it("renders the child route via Outlet", () => {
    renderAt("/audit/deals");
    expect(screen.getByText("Deals content")).toBeInTheDocument();
  });
});
