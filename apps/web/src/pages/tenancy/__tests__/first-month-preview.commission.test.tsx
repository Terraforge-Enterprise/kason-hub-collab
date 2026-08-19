import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FirstMonthPreviewCard } from "../first-month-preview";

const preview = { month: "2026-08", amount: 3000, occupiedDays: 31, daysInMonth: 31, isProrated: false };
// month deliberately differs from preview.month: proves the card renders
// commission.month, not preview.month, in the "KAEN commission ·" line.
const commission = { month: "2026-09", commissionAmount: 3000, sstRate: 0.08, sstAmount: 240, sstBearer: "owner" as const, total: 3240 };

describe("FirstMonthPreviewCard — commission", () => {
  it("renders the commission line when commission is provided", () => {
    render(<FirstMonthPreviewCard preview={preview} commission={commission} />);
    // Scoped matchers: /commission/i would match both "KAEN commission" and
    // "Commission total"; "RM 240.00" is a substring of "RM 3240.00". Use the
    // distinct label and exact-string amounts so each resolves to ONE element.
    // The month asserted here is commission.month (2026-09), which differs from
    // preview.month (2026-08) -- this fails if the card ever regresses to
    // rendering {preview.month} in the commission line instead.
    expect(screen.getByText(/KAEN commission · 2026-09/)).toBeInTheDocument();
    expect(screen.getByText("RM 240.00")).toBeInTheDocument();  // the SST line
    expect(screen.getByText("RM 3240.00")).toBeInTheDocument(); // the total line
    expect(screen.getByText(/owner bears/i)).toBeInTheDocument();
  });

  it("renders the KAEN-absorbs bearer text when sstBearer is kaen", () => {
    render(
      <FirstMonthPreviewCard preview={preview} commission={{ ...commission, sstBearer: "kaen" }} />,
    );
    expect(screen.getByText(/KAEN absorbs/i)).toBeInTheDocument();
  });

  it("renders the no-commission note when flagged and commission is null", () => {
    render(<FirstMonthPreviewCard preview={preview} commission={null} showNoCommissionNote />);
    expect(screen.getByText(/no full month in this tenancy/i)).toBeInTheDocument();
  });

  it("renders no commission text when not a commission tenancy", () => {
    render(<FirstMonthPreviewCard preview={preview} commission={null} />);
    expect(screen.queryByText(/commission/i)).not.toBeInTheDocument();
  });
});
