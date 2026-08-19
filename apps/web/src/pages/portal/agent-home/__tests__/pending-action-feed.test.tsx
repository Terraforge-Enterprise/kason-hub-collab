import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PendingActionFeed } from "../pending-action-feed";

const rows = [
  { domain: "pipeline" as const,         id: "u1", label: "Sales unit A-1 — needs_amendment", href: "/portal/sales-pipeline?unit=u1", updatedAt: "2026-04-29T10:00:00Z" },
  { domain: "sales-claim" as const,      id: "s1", label: "Sales claim SC-002 — needs_amendment", href: "/portal/sales-claims?id=s1", updatedAt: "2026-04-28T10:00:00Z" },
];

describe("PendingActionFeed", () => {
  it("renders rows with deep links", () => {
    render(<MemoryRouter><PendingActionFeed rows={rows} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /Sales unit A-1/i })).toHaveAttribute("href", "/portal/sales-pipeline?unit=u1");
    expect(screen.getByRole("link", { name: /Sales claim SC-002/i })).toHaveAttribute("href", "/portal/sales-claims?id=s1");
  });

  it("renders an empty-state when no rows", () => {
    render(<MemoryRouter><PendingActionFeed rows={[]} /></MemoryRouter>);
    expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
  });
});
