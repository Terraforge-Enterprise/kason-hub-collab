import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RecentActivity } from "../recent-activity";

describe("RecentActivity", () => {
  it("renders empty state when no rows", () => {
    render(<MemoryRouter><RecentActivity rows={[]} /></MemoryRouter>);
    expect(screen.getByText(/No recent activity/i)).toBeInTheDocument();
  });

  it("renders newest first", () => {
    const rows = [
      { domain: "pipeline" as const, id: "1", label: "Older", href: "#", updatedAt: "2026-04-25T00:00:00Z" },
      { domain: "pipeline" as const, id: "2", label: "Newer", href: "#", updatedAt: "2026-04-29T00:00:00Z" },
    ];
    render(<MemoryRouter><RecentActivity rows={rows} /></MemoryRouter>);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveTextContent("Newer");
  });
});
