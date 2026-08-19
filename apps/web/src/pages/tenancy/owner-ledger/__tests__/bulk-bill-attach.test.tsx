// Tests for BulkBillAttach (Task 7 — D2): bulk per-unit bill upload + list + detach.
//
// BulkBillAttach renders a multi-file dropzone that calls useAttachExpenseProof
// with category: "supporting" (BULK_PROOF_CATEGORY) + both files + the right
// (ownerPartyId, statementMonth, apartmentId) scope, and lists pre-existing
// "supporting" proofs each with a working Remove button that calls
// useDetachExpenseProof.
//
// Run with:
//   cd .../phase2-owner-billing/apps/web && \
//     /Users/yonghongtan/github/Kason-Hub/node_modules/.bin/vitest run \
//     src/pages/tenancy/owner-ledger/__tests__/bulk-bill-attach.test.tsx --no-coverage
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ── Stubs for the three hooks BulkBillAttach uses ──────────────────────────────

const attachMutate = vi.fn();
const detachMutate = vi.fn();

vi.mock("@/api/owner-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-billing")>();
  return {
    ...actual,
    useAttachExpenseProof: () => ({ mutate: attachMutate, isPending: false }),
    useDetachExpenseProof: () => ({ mutate: detachMutate, isPending: false }),
    useExpenseProofs: vi.fn(),
  };
});

import { BulkBillAttach } from "../bulk-bill-attach";
import { useExpenseProofs } from "@/api/owner-billing";
import type { ExpenseProofGroup } from "@/api/owner-billing";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeProofGroup(proofs: Array<{ id: string; filename: string; url: string }>): { data: ExpenseProofGroup[] } {
  return {
    data: proofs.length > 0 ? [{ category: "supporting", proofs }] : [],
  };
}

function mockProofs(groups: { data: ExpenseProofGroup[] } | null) {
  vi.mocked(useExpenseProofs).mockReturnValue({
    data: groups ?? undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useExpenseProofs>);
}

function renderComponent() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BulkBillAttach ownerPartyId="o1" month="2026-06" apartmentId="a1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("BulkBillAttach — dropzone upload", () => {
  it("renders the dropzone with the correct label", () => {
    mockProofs(makeProofGroup([]));
    renderComponent();
    // Should have a dropzone / upload button
    expect(screen.getByRole("button", { name: /drop|upload|attach/i })).toBeTruthy();
  });

  it("calls attachExpenseProof with category 'supporting' + both files + correct scope when files are selected", () => {
    mockProofs(makeProofGroup([]));
    const { container } = renderComponent();

    const fileInput = container.querySelector("input[type='file']") as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file1 = new File(["tnb"], "tnb-june.pdf", { type: "application/pdf" });
    const file2 = new File(["receipt"], "receipt.pdf", { type: "application/pdf" });

    // Simulate file selection via the hidden input
    Object.defineProperty(fileInput, "files", {
      value: [file1, file2],
      configurable: true,
    });
    fireEvent.change(fileInput);

    expect(attachMutate).toHaveBeenCalledTimes(1);
    expect(attachMutate).toHaveBeenCalledWith(
      {
        ownerPartyId: "o1",
        statementMonth: "2026-06",
        apartmentId: "a1",
        category: "supporting",
        files: [file1, file2],
      },
      expect.anything(),
    );
  });
});

describe("BulkBillAttach — existing proofs list + detach", () => {
  it("renders pre-seeded supporting proofs with filename + remove button", () => {
    mockProofs(
      makeProofGroup([
        { id: "proof-1", filename: "tnb-june.pdf", url: "https://signed.example/tnb.pdf" },
        { id: "proof-2", filename: "water-june.pdf", url: "https://signed.example/water.pdf" },
      ]),
    );
    renderComponent();

    // Filenames appear
    expect(screen.getByText("tnb-june.pdf")).toBeTruthy();
    expect(screen.getByText("water-june.pdf")).toBeTruthy();

    // Remove buttons appear for each proof
    expect(screen.getByRole("button", { name: /remove.*tnb-june\.pdf/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove.*water-june\.pdf/i })).toBeTruthy();
  });

  it("shows empty state text when there are no supporting proofs yet", () => {
    mockProofs(makeProofGroup([]));
    renderComponent();
    expect(screen.getByText(/no supporting bills/i)).toBeTruthy();
  });

  it("calls detachExpenseProof with the proof id when the remove button is clicked", () => {
    mockProofs(
      makeProofGroup([
        { id: "proof-1", filename: "tnb-june.pdf", url: "https://signed.example/tnb.pdf" },
      ]),
    );
    renderComponent();

    const removeBtn = screen.getByRole("button", { name: /remove.*tnb-june\.pdf/i });
    fireEvent.click(removeBtn);

    expect(detachMutate).toHaveBeenCalledTimes(1);
    expect(detachMutate).toHaveBeenCalledWith("proof-1", expect.anything());
  });
});
