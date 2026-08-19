// Smoke tests for EntryFormDrawer — create mode + edit mode.
// - Verify key fields are rendered
// - Verify direction options do NOT include "payout"
// - Verify submit calls the mocked mutation with a well-formed body
// - Verify 409 behaviour keeps drawer open + shows stale toast
// - T3: cascade tests — property disabled until owner, unit select, tenant panel,
//   Apply-to select, apartmentId in submit body
// - 2c-5: attachment upload control renders; uploaded key flows into submit payload
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ── usePhase2AttachmentUpload mock (2c-5) ─────────────────────────────────────
// Captures the onUploaded callback so tests can drive key collection directly,
// and exposes enqueue/reset spies to assert they are wired.
let capturedOnUploaded: (key: string) => void = () => {};
const mockUploadEnqueue = vi.fn();
const mockUploadReset = vi.fn();

vi.mock("@/hooks/use-phase2-attachment-upload", () => ({
  usePhase2AttachmentUpload: (opts: { onUploaded: (key: string) => void }) => {
    capturedOnUploaded = opts.onUploaded;
    return {
      items: [] as [],
      enqueue: mockUploadEnqueue,
      retry: vi.fn(),
      reset: mockUploadReset,
      isUploading: false,
    };
  },
}));

import { toast } from "sonner";
import type { OwnerLedgerEntryRow } from "@/api/owner-ledger";
import { EntryFormDrawer } from "../entry-form-drawer";

// The hooks call useMutation internally; we need to control the mutate fn.
// Mock the entire owner-ledger api module so we can replace mutate.
const mockCreateMutate = vi.fn();
const mockPatchMutate = vi.fn();

vi.mock("@/api/owner-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-ledger")>();
  return {
    ...actual,
    useCreateLedgerEntry: () => ({
      mutate: mockCreateMutate,
      isPending: false,
    }),
    usePatchLedgerEntry: () => ({
      mutate: mockPatchMutate,
      isPending: false,
    }),
    useOwnerTree: (ownerPartyId: string | null) => ({
      data:
        ownerPartyId === "owner-1"
          ? {
              data: {
                properties: [
                  {
                    id: "prop-1",
                    name: "Areca Residences",
                    units: [
                      {
                        apartmentId: "apt-1",
                        unitCode: "A-01",
                        listingMode: "WHOLE" as const,
                        rooms: [
                          {
                            listingId: "listing-1",
                            listingType: "Master",
                            occupancyStatus: "occupied",
                            tenancy: {
                              tenancyId: "ten-1",
                              tenantDisplayName: "Ahmad Zaki",
                            },
                          },
                        ],
                      },
                      {
                        apartmentId: "apt-2",
                        unitCode: "A-02",
                        listingMode: "PARTITIONED" as const,
                        rooms: [
                          {
                            listingId: "listing-2",
                            listingType: "Room A",
                            occupancyStatus: "occupied",
                            tenancy: {
                              tenancyId: "ten-2",
                              tenantDisplayName: "Siti Rahimah",
                            },
                          },
                          {
                            listingId: "listing-3",
                            listingType: "Room B",
                            occupancyStatus: "vacant",
                            tenancy: null,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            }
          : undefined,
      isLoading: false,
    }),
  };
});

// ── Fixtures ────────────────────────────────────────────────────────────────────

const owners = [
  { id: "owner-1", displayName: "Tan Sri Lim" },
  { id: "owner-2", displayName: "Datuk Wong" },
];

function makeEntry(over: Partial<OwnerLedgerEntryRow> = {}): OwnerLedgerEntryRow {
  return {
    id: "entry-1",
    organizationId: "org-1",
    ownerPartyId: "owner-1",
    propertyId: "prop-1",
    apartmentId: null,
    unitCode: null,
    listingId: null,
    tenancyId: null,
    statementMonth: "2026-06-01T00:00:00.000Z",
    transactionDate: "2026-06-15",
    direction: "income",
    category: "rental_income",
    description: "June rent",
    remarks: null,
    amount: "2000.00",
    chargedAmount: null,
    debitAdjustmentAmount: "0.00",
    creditAdjustmentAmount: "0.00",
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    taxCategory: "not_applicable",
    includeInPayout: true,
    attachmentKeys: [],
    sourceType: "manual",
    sourceChargeId: null,
    sourceUtilityBillId: null,
    status: "active",
    createdById: "admin-1",
    updatedById: "admin-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

// ── Render helper ───────────────────────────────────────────────────────────────

type RenderOpts = {
  open?: boolean;
  mode?: "create" | "edit";
  entry?: OwnerLedgerEntryRow;
  readOnly?: boolean;
};

function renderDrawer({ open = true, mode = "create", entry, readOnly }: RenderOpts = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EntryFormDrawer
          open={open}
          onClose={onClose}
          mode={mode}
          entry={entry}
          owners={owners}
          readOnly={readOnly}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("EntryFormDrawer — create mode", () => {
  it("renders the drawer title", () => {
    renderDrawer({ mode: "create" });
    expect(screen.getByText(/New ledger entry/i)).toBeInTheDocument();
  });

  it("renders key form fields", () => {
    renderDrawer({ mode: "create" });
    expect(screen.getByRole("combobox", { name: /^Owner$/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Property$/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Direction$/i })).toBeInTheDocument();
    // There are two selects that match "Category" (Category + Tax category) — just
    // assert both are present using getAllByRole.
    const categorySelects = screen.getAllByRole("combobox", { name: /category/i });
    expect(categorySelects.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("combobox", { name: /^Paid by$/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Payment status$/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Tax category$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Amount$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/SST amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Description$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Remarks$/i)).toBeInTheDocument();
  });

  it("direction select does NOT include payout option", () => {
    renderDrawer({ mode: "create" });
    const directionSelect = screen.getByRole("combobox", { name: /Direction/i });
    const options = within(directionSelect).queryAllByRole("option");
    const optionValues = options.map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).not.toContain("payout");
    expect(optionValues).toContain("income");
    expect(optionValues).toContain("expense");
  });

  it("shows validation errors when submitting empty form", async () => {
    renderDrawer({ mode: "create" });
    const submitBtn = screen.getByRole("button", { name: /Create entry/i });
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByText(/Owner is required/i)).toBeInTheDocument();
    });
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("Property select is disabled until an owner is chosen", () => {
    renderDrawer({ mode: "create" });
    const propertySelect = screen.getByRole("combobox", {
      name: /^Property$/i,
    }) as HTMLSelectElement;
    expect(propertySelect.disabled).toBe(true);
  });

  it("Selecting an owner enables the Property select with owner's properties", async () => {
    renderDrawer({ mode: "create" });
    const ownerSelect = screen.getByRole("combobox", { name: /^Owner$/i });
    fireEvent.change(ownerSelect, { target: { value: "owner-1" } });

    await waitFor(() => {
      const propertySelect = screen.getByRole("combobox", {
        name: /^Property$/i,
      }) as HTMLSelectElement;
      expect(propertySelect.disabled).toBe(false);
      expect(
        within(propertySelect).getByRole("option", { name: /Areca Residences/i }),
      ).toBeInTheDocument();
    });
  });

  it("Selecting a unit shows the tenant panel for WHOLE unit", async () => {
    renderDrawer({ mode: "create" });

    // Select owner
    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });

    // Select property (wait for tree to populate)
    await waitFor(() => {
      const propertySelect = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(propertySelect.disabled).toBe(false);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });

    // Select unit A-01 (WHOLE)
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /^Unit$/i })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Unit$/i }), {
      target: { value: "apt-1" },
    });

    // Tenant panel should show Ahmad Zaki
    await waitFor(() => {
      expect(screen.getByText("Ahmad Zaki")).toBeInTheDocument();
    });
  });

  it("PARTITION unit shows all room-tenants in panel", async () => {
    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });
    await waitFor(() => {
      const propertySelect = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(propertySelect.disabled).toBe(false);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /^Unit$/i })).toBeInTheDocument();
    });

    // Select unit A-02 (PARTITIONED)
    fireEvent.change(screen.getByRole("combobox", { name: /^Unit$/i }), {
      target: { value: "apt-2" },
    });

    await waitFor(() => {
      expect(screen.getByText("Siti Rahimah")).toBeInTheDocument();
      expect(screen.getByText("Vacant")).toBeInTheDocument();
    });
  });

  it("Apply to select sets listingId in submit body", async () => {
    mockCreateMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });
    await waitFor(() => {
      const prop = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(prop.disabled).toBe(false);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^Unit$/i })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByRole("combobox", { name: /^Unit$/i }), {
      target: { value: "apt-2" },
    });

    // Apply to — select listing-2 (Room A / Siti Rahimah)
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^Apply to$/i })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByRole("combobox", { name: /^Apply to$/i }), {
      target: { value: "listing-2" },
    });

    // Fill required fields
    fireEvent.change(screen.getByLabelText(/Statement month/i), { target: { value: "2026-06" } });
    fireEvent.change(screen.getByLabelText(/Transaction date/i), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Direction$/i }), { target: { value: "income" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), { target: { value: "rental_income" } });
    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: "2000.00" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), { target: { value: "kaen" } });

    fireEvent.click(screen.getByRole("button", { name: /Create entry/i }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));

    const [body] = mockCreateMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.listingId).toBe("listing-2");
    expect(body.tenancyId).toBe("ten-2");
    expect(body.apartmentId).toBe("apt-2");
  });

  it("Submit body includes apartmentId when unit is selected", async () => {
    mockCreateMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });
    await waitFor(() => {
      const prop = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(prop.disabled).toBe(false);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^Unit$/i })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByRole("combobox", { name: /^Unit$/i }), {
      target: { value: "apt-1" },
    });

    fireEvent.change(screen.getByLabelText(/Statement month/i), { target: { value: "2026-06" } });
    fireEvent.change(screen.getByLabelText(/Transaction date/i), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Direction$/i }), { target: { value: "income" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), { target: { value: "rental_income" } });
    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: "2000.00" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), { target: { value: "kaen" } });

    fireEvent.click(screen.getByRole("button", { name: /Create entry/i }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));

    const [body] = mockCreateMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.apartmentId).toBe("apt-1");
  });

  it("calls createEntry.mutate with a well-formed body on valid submit", async () => {
    mockCreateMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "create" });

    // Fill in owner
    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });
    // Wait for tree to load and property to be enabled
    await waitFor(() => {
      const propertySelect = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(propertySelect.disabled).toBe(false);
    });
    // Fill in property
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });
    // Statement month (type=month — use TextInput which renders <input>)
    fireEvent.change(screen.getByLabelText(/Statement month/i), {
      target: { value: "2026-06" },
    });
    // Transaction date
    fireEvent.change(screen.getByLabelText(/Transaction date/i), {
      target: { value: "2026-06-15" },
    });
    // Direction
    fireEvent.change(screen.getByRole("combobox", { name: /^Direction$/i }), {
      target: { value: "income" },
    });
    // Category (use exact label match to avoid matching "Tax category")
    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "rental_income" },
    });
    // Amount
    fireEvent.change(screen.getByLabelText(/^Amount/i), {
      target: { value: "2000.00" },
    });
    // Paid by
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), {
      target: { value: "kaen" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create entry/i }));

    await waitFor(() => {
      expect(mockCreateMutate).toHaveBeenCalledTimes(1);
    });

    const [body] = mockCreateMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.ownerPartyId).toBe("owner-1");
    expect(body.propertyId).toBe("prop-1");
    expect(body.direction).toBe("income");
    expect(body.category).toBe("rental_income");
    expect(body.amount).toBe("2000.00");
    expect(body.paidBy).toBe("kaen");
    // statementMonth must be YYYY-MM (shared schema monthString; NOT a full ISO date)
    expect(body.statementMonth).toBe("2026-06");
    // payout should never appear in the body
    expect(body.direction).not.toBe("payout");
  });

  it("shows 'Counts toward owner payout' hint when paidBy=kaen", async () => {
    renderDrawer({ mode: "create" });
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), {
      target: { value: "kaen" },
    });
    await waitFor(() => {
      // Callout renders title (bold) + body text — use getAllByText since both
      // the title span and the body span contain this phrase.
      const matches = screen.getAllByText(/Counts toward owner payout/i);
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it("shows 'Excluded from payout' hint when paidBy=owner", async () => {
    renderDrawer({ mode: "create" });
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), {
      target: { value: "owner" },
    });
    await waitFor(() => {
      // Callout renders both a title span and a body text — use getAllByText.
      const matches = screen.getAllByText(/Excluded from payout/i);
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  // ── T3: category-driven Paid By + Tax Category ──────────────────────────────

  it("selecting 'cleaning' sets Paid By=kaen and renders locked (no free select)", async () => {
    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "cleaning" },
    });

    await waitFor(() => {
      // The locked display text should show "Kaen"
      expect(screen.getByText(/^Kaen$/i)).toBeInTheDocument();
      // Lock icon should be present (rendered with aria-hidden)
      expect(document.querySelector("svg")).not.toBeNull();
      // No free select for Paid By — it's replaced by the locked display
      const paidBySelect = screen.queryByRole("combobox", { name: /^Paid by$/i });
      expect(paidBySelect).toBeNull();
      // Override button should be visible
      expect(screen.getByRole("button", { name: /Override paid by/i })).toBeInTheDocument();
    });
  });

  it("selecting 'cleaning' auto-fills Tax Category = not_applicable", async () => {
    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "cleaning" },
    });

    await waitFor(() => {
      const taxSelect = screen.getByRole("combobox", { name: /^Tax category$/i }) as HTMLSelectElement;
      expect(taxSelect.value).toBe("not_applicable");
      // Tax category is always editable — it's still a combobox
      expect(taxSelect).not.toBeDisabled();
    });
  });

  it("Override on locked category reveals Paid By select + reason input", async () => {
    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "cleaning" },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Override paid by/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Override paid by/i }));

    await waitFor(() => {
      // Paid By select is now visible
      expect(screen.getByRole("combobox", { name: /^Paid by$/i })).toBeInTheDocument();
      // Override reason input is also visible
      expect(screen.getByLabelText(/Override reason/i)).toBeInTheDocument();
    });
  });

  it("Override with reason appends [paid-by override: <reason>] to remarks on submit", async () => {
    mockCreateMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "create" });

    // Select owner + property
    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });
    await waitFor(() => {
      const prop = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(prop.disabled).toBe(false);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });

    // Fill required fields
    fireEvent.change(screen.getByLabelText(/Statement month/i), { target: { value: "2026-06" } });
    fireEvent.change(screen.getByLabelText(/Transaction date/i), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Direction$/i }), { target: { value: "expense" } });

    // Select a locked category (cleaning)
    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "cleaning" },
    });

    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: "200.00" } });

    // Activate override
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Override paid by/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Override paid by/i }));

    // Change Paid By to "owner"
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /^Paid by$/i })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), {
      target: { value: "owner" },
    });

    // Fill override reason
    fireEvent.change(screen.getByLabelText(/Override reason/i), {
      target: { value: "Owner settled directly" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create entry/i }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));

    const [body] = mockCreateMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.paidBy).toBe("owner");
    expect(typeof body.remarks).toBe("string");
    expect(body.remarks as string).toContain("[paid-by override: Owner settled directly]");
  });

  it("selecting 'assessment' defaults Paid By=kaen but keeps it editable", async () => {
    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "assessment" },
    });

    await waitFor(() => {
      // Paid By should still be a free select (paidByLocked=false for statutory)
      const paidBySelect = screen.getByRole("combobox", { name: /^Paid by$/i }) as HTMLSelectElement;
      expect(paidBySelect).toBeInTheDocument();
      expect(paidBySelect.value).toBe("kaen");
    });

    // Can freely switch to "owner"
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), {
      target: { value: "owner" },
    });
    const paidBySelect = screen.getByRole("combobox", { name: /^Paid by$/i }) as HTMLSelectElement;
    expect(paidBySelect.value).toBe("owner");
  });

  it("Tax Category is always editable (even for locked categories)", async () => {
    renderDrawer({ mode: "create" });

    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "cleaning" },
    });

    await waitFor(() => {
      const taxSelect = screen.getByRole("combobox", { name: /^Tax category$/i }) as HTMLSelectElement;
      expect(taxSelect).not.toBeDisabled();
    });

    // Can freely change tax category
    fireEvent.change(screen.getByRole("combobox", { name: /^Tax category$/i }), {
      target: { value: "capital_expense" },
    });
    const taxSelect = screen.getByRole("combobox", { name: /^Tax category$/i }) as HTMLSelectElement;
    expect(taxSelect.value).toBe("capital_expense");
  });

  it("changing category in edit mode re-applies defaults", async () => {
    // Start in edit mode with rental_income entry
    const entry = makeEntry({ category: "rental_income", paidBy: "kaen", taxCategory: "not_applicable" });
    renderDrawer({ mode: "edit", entry });

    // Change category to assessment (statutory, paidByLocked=false, taxCategory=rental_expense)
    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "assessment" },
    });

    await waitFor(() => {
      const taxSelect = screen.getByRole("combobox", { name: /^Tax category$/i }) as HTMLSelectElement;
      expect(taxSelect.value).toBe("rental_expense");
      const paidBySelect = screen.getByRole("combobox", { name: /^Paid by$/i }) as HTMLSelectElement;
      expect(paidBySelect.value).toBe("kaen");
    });
  });
});

describe("EntryFormDrawer — edit mode", () => {
  it("renders 'Edit ledger entry' title in edit mode", () => {
    renderDrawer({ mode: "edit", entry: makeEntry() });
    expect(screen.getByText(/Edit ledger entry/i)).toBeInTheDocument();
  });

  it("hydrates fields from the provided entry", () => {
    renderDrawer({ mode: "edit", entry: makeEntry() });
    const ownerSelect = screen.getByRole("combobox", { name: /Owner/i }) as HTMLSelectElement;
    expect(ownerSelect.value).toBe("owner-1");
    const propertySelect = screen.getByRole("combobox", { name: /Property/i }) as HTMLSelectElement;
    expect(propertySelect.value).toBe("prop-1");
    const amountInput = screen.getByLabelText(/^Amount/i) as HTMLInputElement;
    expect(amountInput.value).toBe("2000.00");
  });

  it("calls patchEntry.mutate with expectedUpdatedAt on submit", async () => {
    const entry = makeEntry({ updatedAt: "2026-06-01T10:00:00.000Z" });
    mockPatchMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "edit", entry });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(mockPatchMutate).toHaveBeenCalledTimes(1);
    });

    const [body] = mockPatchMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.id).toBe("entry-1");
    expect(body.expectedUpdatedAt).toBe("2026-06-01T10:00:00.000Z");
    expect(body.direction).not.toBe("payout");
  });

  it("shows stale toast and keeps drawer open on 409-like error", async () => {
    const entry = makeEntry();
    const { onClose } = renderDrawer({ mode: "edit", entry });

    mockPatchMutate.mockImplementation((_body: unknown, opts: { onError?: (e: Error) => void }) => {
      opts?.onError?.(new Error("409 Conflict — entry was updated elsewhere"));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/updated elsewhere/i),
      );
    });
    // Drawer stays open — onClose not called
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("EntryFormDrawer — read-only mode", () => {
  it("renders no Save button and disables fields when readOnly", () => {
    renderDrawer({ mode: "edit", entry: makeEntry(), readOnly: true });
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();
    expect(screen.queryByText(/Optimistic concurrency/i)).toBeNull();
    // Amount field is disabled — via the ancestor `<fieldset disabled>` cascade.
    // Native HTMLInputElement.disabled only reflects the element's OWN attribute
    // (confirmed empirically: jsdom + real browsers alike leave it `false` here —
    // see MDN's HTMLFieldSetElement.disabled notes), so this must use jest-dom's
    // toBeDisabled(), which correctly walks ancestor <fieldset> per the HTML spec.
    // Matches this file's existing convention (see the Tax Category assertions above).
    expect(screen.getByLabelText("Amount")).toBeDisabled();
  });

  it("does not enqueue an upload when a file is drag-and-dropped on the attachment zone (fieldset disabled does not block drag events)", () => {
    renderDrawer({ mode: "edit", entry: makeEntry(), readOnly: true });

    const dropzone = screen.getByRole("button", { name: /Upload bill scans/i });
    // Sanity check — the dropzone itself should read as disabled too.
    expect(dropzone).toBeDisabled();

    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [new File(["dummy"], "sneaky.pdf", { type: "application/pdf" })],
      },
    });

    expect(mockUploadEnqueue).not.toHaveBeenCalled();
  });
});

// ── 2c-5: attachment upload affordance ──────────────────────────────────────────
// These tests verify that the entry form renders a file-upload control and that
// keys collected via usePhase2AttachmentUpload's onUploaded callback land in the
// form's attachmentKeys and are included in the create/patch mutation payload.

describe("EntryFormDrawer — attachment upload (2c-5)", () => {
  it("renders the file upload control (dropzone button)", () => {
    renderDrawer({ mode: "create" });
    expect(screen.getByRole("button", { name: /Upload bill scans/i })).toBeInTheDocument();
  });

  it("uploading a file adds its key to the attachment list and submit payload", async () => {
    mockCreateMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "create" });

    // Simulate the hook calling onUploaded after a successful storage PUT.
    act(() => {
      capturedOnUploaded("owner-ledger-entries/test-scan.pdf");
    });

    // The key's filename should appear as a badge.
    await waitFor(() => {
      expect(screen.getByText("test-scan.pdf")).toBeInTheDocument();
    });

    // Fill in required fields to enable submit.
    fireEvent.change(screen.getByRole("combobox", { name: /^Owner$/i }), {
      target: { value: "owner-1" },
    });
    await waitFor(() => {
      const prop = screen.getByRole("combobox", { name: /^Property$/i }) as HTMLSelectElement;
      expect(prop.disabled).toBe(false);
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Property$/i }), {
      target: { value: "prop-1" },
    });
    fireEvent.change(screen.getByLabelText(/Statement month/i), { target: { value: "2026-06" } });
    fireEvent.change(screen.getByLabelText(/Transaction date/i), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Direction$/i }), {
      target: { value: "income" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Category$/i }), {
      target: { value: "rental_income" },
    });
    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: "2000.00" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Paid by$/i }), {
      target: { value: "kaen" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create entry/i }));

    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));

    const [body] = mockCreateMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.attachmentKeys).toEqual(["owner-ledger-entries/test-scan.pdf"]);
  });

  it("edit mode seeds existing attachmentKeys and includes them in the patch payload", async () => {
    const entry = makeEntry({
      attachmentKeys: ["owner-ledger-entries/existing-scan.pdf"],
    });
    mockPatchMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "edit", entry });

    // The pre-existing key should render as a badge immediately.
    await waitFor(() => {
      expect(screen.getByText("existing-scan.pdf")).toBeInTheDocument();
    });

    // Submit without changes — key must still be in payload.
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(mockPatchMutate).toHaveBeenCalledTimes(1));

    const [body] = mockPatchMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect((body.attachmentKeys as string[])).toContain("owner-ledger-entries/existing-scan.pdf");
  });

  it("removing an attachment badge excludes that key from the submit payload", async () => {
    const entry = makeEntry({
      attachmentKeys: [
        "owner-ledger-entries/scan-a.pdf",
        "owner-ledger-entries/scan-b.pdf",
      ],
    });
    mockPatchMutate.mockImplementation((_body: unknown, opts: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });

    renderDrawer({ mode: "edit", entry });

    await waitFor(() => {
      expect(screen.getByText("scan-a.pdf")).toBeInTheDocument();
      expect(screen.getByText("scan-b.pdf")).toBeInTheDocument();
    });

    // Remove scan-a via its badge × button.
    fireEvent.click(screen.getByRole("button", { name: /Remove scan-a.pdf/i }));

    await waitFor(() => {
      expect(screen.queryByText("scan-a.pdf")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    await waitFor(() => expect(mockPatchMutate).toHaveBeenCalledTimes(1));

    const [body] = mockPatchMutate.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body.attachmentKeys).toEqual(["owner-ledger-entries/scan-b.pdf"]);
  });
});
