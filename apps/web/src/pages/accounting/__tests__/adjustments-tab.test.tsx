// Invoice-adjustments rework (Change 3) — the Adjustments tab's register table
// (Phase 4.2 Void behavior, unchanged) PLUS the inline "add adjustment" row
// that REPLACES the old CreateNoteDrawer popup. Tests the AdjustmentsTab leaf
// component directly (mirrors docs-filter-controls.test.tsx), mocking only the
// void/create mutation hooks + the PDF-open helper.
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDocumentLineDto } from "@kason/shared";
import type { RelatedDocumentRow } from "../adjustments-tab";

const voidMutate = vi.fn();
const createMutate = vi.fn();
vi.mock("../../../api/billing-documents", () => ({
  fetchBillingDocumentPdfUrl: vi.fn(),
  useVoidChargeAdjustment: () => ({ mutate: voidMutate, isPending: false }),
  useCreateChargeAdjustment: () => ({ mutate: createMutate, isPending: false }),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => ({ data: {} })),
  ApiError: class ApiError extends Error {
    status: number;
    data?: unknown;
    constructor(message: string, status = 400, code?: string, data?: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
  },
}));

vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });

import { AdjustmentsTab } from "../adjustments-tab";

const ISSUED_CN: RelatedDocumentRow = { id: "cn1", docType: "credit_note", documentNumber: "CNTEN-0001", status: "issued" };
const SETTLED_DN: RelatedDocumentRow = { id: "dn1", docType: "debit_note", documentNumber: "DNTEN-0002", status: "settled" };

function chargeLine(over: Partial<BillingDocumentLineDto> & Pick<BillingDocumentLineDto, "id" | "chargeId" | "description">): BillingDocumentLineDto {
  return {
    amount: "0.00",
    sstRate: "0",
    sstAmount: "0.00",
    categoryName: "Utilities",
    unitCode: null,
    paid: "0.00",
    outstanding: "0.00",
    originalAmount: "0.00",
    debitAdjustmentAmount: "0.00",
    creditAdjustmentAmount: "0.00",
    netAdjustmentAmount: "0.00",
    adjustedAmount: "0.00",
    adjustedSstAmount: "0.00",
    allocationBasis: "exact",
    adjustments: [],
    attachments: [],
    isTax: false,
    taxParentChargeId: null,
    ...over,
  };
}

const WATER_LINE = chargeLine({ id: "l1", chargeId: "charge-water", description: "Water", amount: "123.00", originalAmount: "123.00" });

function renderTab(props: Partial<ComponentProps<typeof AdjustmentsTab>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdjustmentsTab
        relatedDocuments={[ISSUED_CN, SETTLED_DN]}
        lines={[WATER_LINE]}
        counterpartyType="tenant"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("AdjustmentsTab — inline add-row (invoice-adjustments rework, Change 3)", () => {
  beforeEach(() => {
    voidMutate.mockReset();
    createMutate.mockReset();
  });

  it("shows no add-row when canCreateNotes is false (default) — no Type/Line/Description/Amount/Add", () => {
    renderTab();
    expect(screen.queryByLabelText(/^type$/i)).toBeNull();
    expect(screen.queryByLabelText(/line item/i)).toBeNull();
    expect(screen.queryByLabelText(/^description$/i)).toBeNull();
    expect(screen.queryByLabelText(/^amount$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^add$/i })).toBeNull();
  });

  it("renders the inline add-row (Type/Document/Line/Description/Amount/Add) when canCreateNotes is true", () => {
    renderTab({ canCreateNotes: true });
    expect(screen.getByLabelText(/^type$/i)).toBeInTheDocument();
    expect(screen.getByText("Auto (CN)")).toBeInTheDocument();
    expect(screen.getByLabelText(/line item/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^description$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^amount$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });

  it("the Document placeholder tracks the Type selection (Auto (CN) / Auto (DN)) — no fabricated number", () => {
    renderTab({ canCreateNotes: true });
    expect(screen.getByText("Auto (CN)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: "debit" } });
    expect(screen.getByText("Auto (DN)")).toBeInTheDocument();
    expect(screen.queryByText(/^\d/)).toBeNull(); // never a real doc number
  });

  it("an owner document with canCreateNotes false (e.g. viewing a CN's own detail) shows nothing — no stale owner-statement note (seam #4)", () => {
    renderTab({ canCreateNotes: false, counterpartyType: "owner" });
    expect(screen.queryByRole("button", { name: /^add$/i })).toBeNull();
    expect(screen.queryByText(/owner-statement flow/i)).toBeNull();
  });

  it("owner add-row: owner document with canCreateNotes renders the same inline add-row as tenant (seam #4)", () => {
    renderTab({ canCreateNotes: true, counterpartyType: "owner" });
    expect(screen.getByLabelText(/^type$/i)).toBeInTheDocument();
    expect(screen.getByText("Auto (CN)")).toBeInTheDocument();
    expect(screen.getByLabelText(/line item/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^description$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^amount$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
    expect(screen.queryByText(/owner-statement flow/i)).toBeNull();
  });

  it("selecting a line + entering description and amount, then clicking Add, calls useCreateChargeAdjustment with the right shape", () => {
    renderTab({ canCreateNotes: true });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "Wrong meter reading" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "23.00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({
      chargeId: "charge-water",
      kind: "credit",
      amount: "23.00",
      description: "Wrong meter reading",
    });
  });

  it("debit type is sent as kind: 'debit'", () => {
    renderTab({ canCreateNotes: true });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: "debit" } });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "Extra usage" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "50.00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(createMutate.mock.calls[0][0]).toMatchObject({ kind: "debit", amount: "50.00" });
  });

  it("amount ≤ 0 is blocked — Add shows an inline error and never calls the mutation", () => {
    renderTab({ canCreateNotes: true });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "Bad amount" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/enter an amount greater than zero/i)).toBeInTheDocument();
  });

  it("missing line or description is blocked inline — no mutation call", () => {
    renderTab({ canCreateNotes: true });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/choose a line to adjust/i)).toBeInTheDocument();
    expect(screen.getByText(/description is required/i)).toBeInTheDocument();
  });

  it("CREDIT_EXCEEDS_ADJUSTABLE is surfaced as an inline error on the Amount field", async () => {
    const { ApiError } = await import("@/lib/api-client");
    createMutate.mockImplementation((_vars: unknown, opts?: { onError?: (e: Error) => void }) => {
      opts?.onError?.(new ApiError("CREDIT_EXCEEDS_ADJUSTABLE", 400));
    });
    renderTab({ canCreateNotes: true });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "Too much" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "999.00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByText(/exceed the amount still owed/i)).toBeInTheDocument();
  });

  it("clears the row on success", () => {
    createMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: (res: unknown) => void }) => {
      opts?.onSuccess?.({ data: { documentNumber: "CNTEN-0009" } });
    });
    renderTab({ canCreateNotes: true });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "Wrong meter reading" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "23.00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect((screen.getByLabelText(/^description$/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^amount$/i) as HTMLInputElement).value).toBe("");
  });
});

// Reported 2026-08-17 on IVTEN-0002: an SST-bearing RM 1.00 expense offered the
// operator TWO choices — the charge, and "… — SST 8% — RM 0.08". The server already
// moves that sibling with the base's note (createChargeAdjustmentService), so picking
// it relieves the same tax twice. See adjustmentTargetLines for the full reasoning.
describe("AdjustmentsTab — the SST sibling is not a separate line to credit", () => {
  const SST_BASE = chargeLine({
    id: "l-base", chargeId: "charge-sst-base", description: "test own exp sst",
    amount: "1.00", originalAmount: "1.00", sstRate: "8", sstAmount: "0.08",
  });
  const SST_TAX = chargeLine({
    id: "l-tax", chargeId: "charge-sst-tax", description: "test own exp sst — SST 8%",
    amount: "0.08", originalAmount: "0.08", isTax: true, taxParentChargeId: "charge-sst-base",
  });

  beforeEach(() => createMutate.mockReset());

  it("the picker offers the charge but NOT its SST sibling", () => {
    renderTab({ canCreateNotes: true, lines: [WATER_LINE, SST_BASE, SST_TAX] });
    const picker = screen.getByLabelText(/line item/i);
    expect(within(picker).getByRole("option", { name: /test own exp sst — RM 1\.00/ })).toBeInTheDocument();
    expect(within(picker).queryByRole("option", { name: /SST 8%/ })).toBeNull();
  });

  it("picking the SST-bearing charge says the tax rides along", () => {
    renderTab({ canCreateNotes: true, lines: [WATER_LINE, SST_BASE, SST_TAX] });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-sst-base" } });
    expect(screen.getByText(/SST 8% moves with this note automatically/i)).toBeInTheDocument();
  });

  it("no such hint on a line that bears no tax", () => {
    renderTab({ canCreateNotes: true, lines: [WATER_LINE, SST_BASE, SST_TAX] });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    expect(screen.queryByText(/moves with this note automatically/i)).toBeNull();
  });

  it("an ORPHAN tax line — base invoiced elsewhere — stays pickable, since no mirror can reach it", () => {
    const orphan = chargeLine({
      id: "l-orphan", chargeId: "charge-orphan-tax", description: "Elsewhere — SST 8%",
      amount: "0.08", originalAmount: "0.08", isTax: true, taxParentChargeId: "charge-on-another-doc",
    });
    renderTab({ canCreateNotes: true, lines: [WATER_LINE, orphan] });
    const picker = screen.getByLabelText(/line item/i);
    expect(within(picker).getByRole("option", { name: /Elsewhere — SST 8%/ })).toBeInTheDocument();
  });

  it("a document whose ONLY line is a mirrored sibling offers nothing to adjust", () => {
    renderTab({ canCreateNotes: true, lines: [SST_BASE, SST_TAX] });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-sst-tax" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "double relief" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "0.08" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    // The option does not exist, so the select never took the value and Add is blocked.
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/choose a line to adjust/i)).toBeInTheDocument();
  });

  it("CHARGE_IS_SST_SIBLING from a stale tab is surfaced inline, pointing at the base", async () => {
    const { ApiError } = await import("@/lib/api-client");
    createMutate.mockImplementation((_vars: unknown, opts?: { onError?: (e: Error) => void }) => {
      opts?.onError?.(new ApiError("CHARGE_IS_SST_SIBLING", 400));
    });
    renderTab({ canCreateNotes: true, lines: [WATER_LINE, SST_BASE, SST_TAX] });
    fireEvent.change(screen.getByLabelText(/line item/i), { target: { value: "charge-water" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "stale" } });
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByText(/SST on another charge/i)).toBeInTheDocument();
  });
});

describe("AdjustmentsTab — void action (Phase 4.2, extended seam #4)", () => {
  beforeEach(() => voidMutate.mockReset());

  it("Void is offered on an ISSUED note but hidden on a non-ISSUED (settled) note", () => {
    renderTab();
    const cnRow = screen.getByText("CNTEN-0001").closest("tr")!;
    expect(within(cnRow).getByRole("button", { name: /^void$/i })).toBeInTheDocument();
    const dnRow = screen.getByText("DNTEN-0002").closest("tr")!;
    expect(within(dnRow).queryByRole("button", { name: /^void$/i })).toBeNull();
  });

  it("Void is now offered for an owner document too (seam #4 removed the owner void 403)", () => {
    renderTab({ counterpartyType: "owner" });
    const cnRow = screen.getByText("CNTEN-0001").closest("tr")!;
    expect(within(cnRow).getByRole("button", { name: /^void$/i })).toBeInTheDocument();
  });

  it("opens a confirm dialog requiring a reason; the button is disabled until one is typed", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^void$/i }));
    const dialog = screen.getByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: /^void$/i });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "issued in error" } });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(voidMutate).toHaveBeenCalledTimes(1);
    expect(voidMutate.mock.calls[0][0]).toMatchObject({ id: "cn1", reason: "issued in error" });
  });

  it("hides the Void button after a successful void (session-local)", () => {
    voidMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^void$/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "issued in error" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^void$/i }));
    expect(screen.queryByRole("button", { name: /^void$/i })).toBeNull();
    expect(screen.getByText("Voided")).toBeInTheDocument();
  });

  it("409 NOTE_HAS_DOWNSTREAM_SETTLEMENTS shows a clear explanation and keeps the dialog open", async () => {
    const { ApiError } = await import("@/lib/api-client");
    voidMutate.mockImplementation((_vars: unknown, opts?: { onError?: (e: Error) => void }) => {
      opts?.onError?.(new ApiError("NOTE_HAS_DOWNSTREAM_SETTLEMENTS", 409));
    });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /^void$/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "issued in error" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^void$/i }));

    expect(await screen.findByText(/applied, paid, or refunded and can't be voided/i)).toBeInTheDocument();
    // Dialog stays open — the confirm button is still reachable to retry/cancel.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
