import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaidByBadge } from "@/components/paid-by-badge";

describe("PaidByBadge", () => {
  it('renders "Paid by KAEN" for paidBy="kaen"', () => {
    render(<PaidByBadge paidBy="kaen" />);
    expect(screen.getByText("Paid by KAEN")).toBeInTheDocument();
  });

  it('renders "Paid by you" for paidBy="owner"', () => {
    render(<PaidByBadge paidBy="owner" />);
    expect(screen.getByText("Paid by you")).toBeInTheDocument();
  });

  it('renders "Paid by Tenant" for paidBy="tenant"', () => {
    render(<PaidByBadge paidBy="tenant" />);
    expect(screen.getByText("Paid by Tenant")).toBeInTheDocument();
  });

  it('renders "Paid by Developer" for paidBy="developer"', () => {
    render(<PaidByBadge paidBy="developer" />);
    expect(screen.getByText("Paid by Developer")).toBeInTheDocument();
  });

  it('renders a fallback label for unknown paidBy values', () => {
    render(<PaidByBadge paidBy="other" />);
    expect(screen.getByText("Paid by other")).toBeInTheDocument();
  });

  it("is case-insensitive for known keys", () => {
    render(<PaidByBadge paidBy="KAEN" />);
    expect(screen.getByText("Paid by KAEN")).toBeInTheDocument();
  });
});
