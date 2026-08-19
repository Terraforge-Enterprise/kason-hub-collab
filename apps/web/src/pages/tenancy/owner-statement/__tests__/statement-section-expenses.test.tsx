// Tests for StatementSectionExpenses' per-expense BILL column (B3).
// useExpenseProofs is mocked to hand back a signed bill for the utilities_tnb row;
// the attach hooks are stubbed so we can assert the multipart attach posts the RAW
// categoryKey + the statement apartmentId. A no-proof row shows "Attach bill".
//
// NOTE: native matchers only (toBeTruthy / toBeNull / toHaveBeenCalledWith) — the
// worktree vitest run does NOT register jest-dom, so toBeInTheDocument is absent.
//
// Run with:
//   cd .../phase2-owner-billing/apps/web && \
//     /Users/yonghongtan/github/Kason-Hub/node_modules/.bin/vitest run \
//     src/pages/tenancy/owner-statement/__tests__/statement-section-expenses.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Stub the proof data + mutation hooks so no network / apiFetch is reached.
const attachMutate = vi.fn();
const detachMutate = vi.fn();
vi.mock("@/api/owner-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-billing")>();
  return {
    ...actual,
    useExpenseProofs: vi.fn(),
    useAttachExpenseProof: () => ({ mutate: attachMutate, isPending: false }),
    useDetachExpenseProof: () => ({ mutate: detachMutate, isPending: false }),
  };
});

import { StatementSectionExpenses } from "../statement-section-expenses";
import { useExpenseProofs } from "@/api/owner-billing";
import type { YannieSections } from "@/api/owner-ledger";

const OWNER = "owner-1";
const MONTH = "2026-06";
const APT = "apt-1";

const TNB_URL = "https://signed.example/tnb.png?token=img";
const WATER_URL = "https://signed.example/water.pdf?token=doc";

const DATA: YannieSections["expenseBreakdown"] = {
  rows: [
    {
      category: "Electricity (TNB)",
      categoryKey: "utilities_tnb",
      description: "TNB June",
      amount: "123.45",
      sstAmount: "0.00",
      paymentStatus: "paid",
    },
    {
      category: "Water",
      categoryKey: "water",
      description: null,
      amount: "30.00",
      sstAmount: "0.00",
      paymentStatus: "paid",
    },
  ],
  totalExpenses: "153.45",
};

function mockProofs(
  groups: Array<{
    category: string;
    proofs: Array<{
      id: string;
      filename: string;
      url: string;
      source?: "manual" | "grid";
      readOnly?: boolean;
    }>;
  }>,
) {
  vi.mocked(useExpenseProofs).mockReturnValue({
    data: { data: groups },
    isLoading: false,
  } as unknown as ReturnType<typeof useExpenseProofs>);
}

function renderSection(editable = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StatementSectionExpenses
        data={DATA}
        ownerPartyId={OWNER}
        statementMonth={MONTH}
        apartmentId={APT}
        editable={editable}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StatementSectionExpenses — per-expense bill column", () => {
  it("renders the Bill column only when the proof scope (owner + month) is supplied", () => {
    mockProofs([]);
    renderSection();
    expect(screen.getByText("Bill")).toBeTruthy();
  });

  it("renders a thumbnail for a row WITH a proof that opens the BillLightbox", async () => {
    mockProofs([
      { category: "utilities_tnb", proofs: [{ id: "p1", filename: "tnb.png", url: TNB_URL }] },
    ]);
    const { container } = renderSection();

    // The TNB row shows the signed bill thumbnail (image key → <img>).
    const thumb = container.querySelector(`img[src="${TNB_URL}"]`);
    expect(thumb).toBeTruthy();

    // No lightbox until the thumbnail is clicked.
    expect(screen.queryByTestId("bill-lightbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview tnb.png" }));

    const lightbox = await screen.findByTestId("bill-lightbox");
    expect(lightbox).toBeTruthy();
    expect(lightbox.getAttribute("role")).toBe("dialog");
    // The big preview <img> carries the signed src (object-contain, not the tile).
    const big = lightbox.querySelector(`img[src="${TNB_URL}"]`);
    expect(big).toBeTruthy();
    expect(big?.className).toContain("object-contain");
    expect(lightbox.textContent).toContain("tnb.png");
  });

  it("attach posts the RAW categoryKey + the statement apartmentId", () => {
    mockProofs([
      { category: "utilities_tnb", proofs: [{ id: "p1", filename: "tnb.png", url: TNB_URL }] },
    ]);
    renderSection();

    const input = screen.getByTestId("expense-attach-input-utilities_tnb") as HTMLInputElement;
    const file = new File(["bytes"], "june-tnb.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(attachMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPartyId: OWNER,
        statementMonth: MONTH,
        apartmentId: APT,
        category: "utilities_tnb",
        files: [file],
      }),
      expect.anything(),
    );
  });

  it("a row with NO proof shows the 'Attach bill' affordance", () => {
    // Only utilities_tnb has a proof — the water row has none.
    mockProofs([
      { category: "utilities_tnb", proofs: [{ id: "p1", filename: "tnb.png", url: TNB_URL }] },
    ]);
    renderSection();

    // The no-proof (water) row shows "Attach bill"; the TNB row shows "Add".
    expect(screen.getByText("Attach bill")).toBeTruthy();
    expect(screen.getByText("Add")).toBeTruthy();
    // The water row's attach input posts category=water.
    expect(screen.getByTestId("expense-attach-input-water")).toBeTruthy();
  });
});

// ─── Read-only grid tiles (sibling of proof-pack-panel's Task-5 guard) ─────────
// A grid-sourced bill (source:"grid", readOnly:true) is surfaced by the same
// resolveStatementBills union that feeds this cell, but must NOT be detachable from
// THIS admin surface either — it belongs to the Bill Grid, not the statement's manual
// proof store (clicking detach on it would 404 against the wrong table).
describe("StatementSectionExpenses — read-only grid tiles", () => {
  it("hides detach for a readOnly (grid) proof but keeps it for a manual proof", () => {
    mockProofs([
      {
        category: "utilities_tnb",
        proofs: [{ id: "g1", filename: "tnb-grid.pdf", url: TNB_URL, source: "grid", readOnly: true }],
      },
      {
        category: "water",
        proofs: [{ id: "m1", filename: "water-manual.pdf", url: WATER_URL, source: "manual", readOnly: false }],
      },
    ]);
    renderSection(true);

    expect(screen.queryByLabelText("Detach tnb-grid.pdf")).toBeNull();
    expect(screen.getByLabelText("Detach water-manual.pdf")).toBeTruthy();
  });
});
