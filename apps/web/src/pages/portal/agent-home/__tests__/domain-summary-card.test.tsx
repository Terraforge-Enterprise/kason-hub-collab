import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Wallet } from "lucide-react";
import { DomainSummaryCard } from "../domain-summary-card";

function renderCard(props: Partial<React.ComponentProps<typeof DomainSummaryCard>> = {}) {
  return render(
    <MemoryRouter>
      <DomainSummaryCard
        title="Sales Claims"
        icon={Wallet}
        glowColor="gold"
        statusCounts={{ submitted: 2, approved: 1 }}
        primaryMetric={{ label: "Approved this month", value: "RM 1,500" }}
        deepLink={{ label: "Open Sales Claims", href: "/portal/sales-claims" }}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("DomainSummaryCard", () => {
  it("renders title, status counts, primary metric, and deep link", () => {
    renderCard();
    expect(screen.getByText("Sales Claims")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Approved this month")).toBeInTheDocument();
    expect(screen.getByText("RM 1,500")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Sales Claims/i })).toHaveAttribute(
      "href",
      "/portal/sales-claims",
    );
  });

  it("renders an unavailable state when statusCounts is null", () => {
    renderCard({ statusCounts: null });
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
  });
});
