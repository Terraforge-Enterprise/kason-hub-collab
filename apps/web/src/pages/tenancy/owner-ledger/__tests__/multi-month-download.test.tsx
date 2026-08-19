// Tests for the D2 month-range download picker (MultiMonthDownload — presentational).
//
// from/to month inputs + an "Include bills" checkbox + a Download button. Clicking
// Download fires onDownload({ fromMonth, toMonth, includeProof }) with the chosen
// params; the PARENT wires the actual ZIP fetch (admin → /owner-billing/statements/
// export with ownerPartyId; portal → the owner-scoped route, NO ownerPartyId field).
//
// Client-side validation MIRRORS D1's server cap so the user sees it BEFORE the
// request: from > to is rejected; a range > 24 months DISABLES download with a
// visible hint (server: monthSpanInclusive > 24 → 400; 24 inclusive is allowed).
//
// NOTE: native matchers only (toBeTruthy / toBeNull / not.toHaveBeenCalled) — the
// worktree vitest run does NOT register jest-dom, so toBeInTheDocument is absent.
//
// Run with:
//   cd .../phase2-owner-billing/apps/web && \
//     /Users/yonghongtan/github/Kason-Hub/node_modules/.bin/vitest run \
//     src/pages/tenancy/owner-ledger/__tests__/multi-month-download.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MultiMonthDownload } from "../multi-month-download";

beforeEach(() => {
  vi.clearAllMocks();
});

function setRange(from: string, to: string) {
  fireEvent.change(screen.getByTestId("multi-month-from"), { target: { value: from } });
  fireEvent.change(screen.getByTestId("multi-month-to"), { target: { value: to } });
}

describe("MultiMonthDownload — month-range picker (D2)", () => {
  it("renders from/to month inputs + an Include bills checkbox + a Download button", () => {
    render(<MultiMonthDownload onDownload={vi.fn()} />);

    expect(screen.getByTestId("multi-month-from")).toBeTruthy();
    expect(screen.getByTestId("multi-month-to")).toBeTruthy();
    expect(screen.getByTestId("multi-month-include-proof")).toBeTruthy();
    expect(screen.getByTestId("multi-month-download-btn")).toBeTruthy();
  });

  it("Download fires onDownload with the chosen range + includeProof", () => {
    const onDownload = vi.fn();
    render(<MultiMonthDownload onDownload={onDownload} />);

    setRange("2026-01", "2026-03");
    fireEvent.click(screen.getByTestId("multi-month-include-proof"));
    fireEvent.click(screen.getByTestId("multi-month-download-btn"));

    expect(onDownload).toHaveBeenCalledWith({
      fromMonth: "2026-01",
      toMonth: "2026-03",
      includeProof: true,
    });
  });

  it("defaults includeProof to false (unchecked)", () => {
    const onDownload = vi.fn();
    render(<MultiMonthDownload onDownload={onDownload} />);

    setRange("2026-01", "2026-01");
    fireEvent.click(screen.getByTestId("multi-month-download-btn"));

    expect(onDownload).toHaveBeenCalledWith({
      fromMonth: "2026-01",
      toMonth: "2026-01",
      includeProof: false,
    });
  });

  it("button is disabled until BOTH months are chosen", () => {
    render(<MultiMonthDownload onDownload={vi.fn()} />);
    const btn = screen.getByTestId("multi-month-download-btn") as HTMLButtonElement;

    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("multi-month-from"), { target: { value: "2026-01" } });
    expect(btn.disabled).toBe(true); // to-month still empty
  });

  it("from > to is rejected client-side (button disabled + message, onDownload NOT called)", () => {
    const onDownload = vi.fn();
    render(<MultiMonthDownload onDownload={onDownload} />);

    setRange("2026-03", "2026-01");
    const btn = screen.getByTestId("multi-month-download-btn") as HTMLButtonElement;

    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/on or before/i)).toBeTruthy();
    fireEvent.click(btn);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("a range > 24 months DISABLES download with a visible hint", () => {
    const onDownload = vi.fn();
    render(<MultiMonthDownload onDownload={onDownload} />);

    // 2024-01 .. 2026-06 = 30 inclusive months (server cap is 24).
    setRange("2024-01", "2026-06");
    const btn = screen.getByTestId("multi-month-download-btn") as HTMLButtonElement;

    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/24 months/i)).toBeTruthy();
    fireEvent.click(btn);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("exactly 24 inclusive months is allowed (mirrors the server boundary)", () => {
    const onDownload = vi.fn();
    render(<MultiMonthDownload onDownload={onDownload} />);

    // 2024-01 .. 2025-12 = 24 inclusive months → allowed.
    setRange("2024-01", "2025-12");
    const btn = screen.getByTestId("multi-month-download-btn") as HTMLButtonElement;

    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onDownload).toHaveBeenCalledWith({
      fromMonth: "2024-01",
      toMonth: "2025-12",
      includeProof: false,
    });
  });

  it("shows a downloading state + disables the button while a download is in flight", () => {
    render(<MultiMonthDownload onDownload={vi.fn()} downloading />);

    const btn = screen.getByTestId("multi-month-download-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("never renders an ownerPartyId field (portal-safe by construction)", () => {
    const { container } = render(<MultiMonthDownload onDownload={vi.fn()} />);

    expect(screen.queryByTestId("multi-month-owner")).toBeNull();
    // No text input that could capture an owner id — only month + checkbox inputs.
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });
});
