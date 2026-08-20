import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetch = vi.fn();
// Re-export the REAL ApiError alongside the mocked apiFetch so tests can
// `new ApiError(...)` and charge-form.tsx's `err instanceof ApiError` check
// resolves against the identical class (Task 5 / Spec2 R10a).
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetch(...args),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChargeForm, defaultChargeNumber } from "../charge-form";
import { ApiError } from "@/lib/api-client";
import { toast } from "sonner";

const CATEGORIES = {
  items: [
    { id: "cat-rental", code: "rental", name: "Monthly rental", family: "pay_back_landlord", docType: "debit_note", seriesId: "s-dep", seriesCode: "DEP", defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 200, description: null, updatedAt: "2026-07-02T00:00:00.000Z" },
    { id: "cat-booking", code: "booking_fee", name: "Booking fee", family: "tenant_income", docType: "invoice", seriesId: "s-ivten", seriesCode: "IVTEN", defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: null, isSystem: false, active: true, sortOrder: 10, description: null, updatedAt: "2026-07-02T00:00:00.000Z" },
  ],
};

function renderForm(props: Partial<React.ComponentProps<typeof ChargeForm>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/billing/charges"]}>
        <ChargeForm layout="drawer" tenancyId="ten-1" unitId="unit-1" defaultPartyId="party-1" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/charge-categories")) return Promise.resolve(CATEGORIES);
    if (path === "/billing/charges") return Promise.resolve({ id: "charge-1" });
    return Promise.resolve({ data: [] });
  });
});

afterEach(() => {
  apiFetch.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.unstubAllEnvs();
});

describe("ChargeForm (flag ON)", () => {
  beforeEach(() => vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "true"));

  it("renders the category dropdown grouped by family and shows the routed-document preview", async () => {
    renderForm();
    const select = (await screen.findByLabelText("Category")) as HTMLSelectElement;
    // Category field renders on mount, before the async /charge-categories fetch
    // resolves — wait for the optgroups the fetch populates, not just the field.
    await waitFor(() => expect(select.querySelectorAll("optgroup")).toHaveLength(2)); // tenant_income + pay_back_landlord present
    fireEvent.change(select, { target: { value: "cat-rental" } });
    expect(await screen.findByText("Will issue a Debit Note in the DEP series.")).toBeTruthy();
    fireEvent.change(select, { target: { value: "cat-booking" } });
    expect(await screen.findByText("Will issue an Invoice in the IVTEN series.")).toBeTruthy();
  });

  it("submits categoryId + chargeType=code + dueDate=<month>-01 and fires onCreated", async () => {
    const onCreated = vi.fn();
    renderForm({ onCreated });
    const select = (await screen.findByLabelText("Category")) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("optgroup")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "cat-rental" } });
    fireEvent.change(screen.getByLabelText("Amount (RM)"), { target: { value: "1500" } });
    // Field wraps its hint text inside the same <label>, so the label's
    // accessible text for "Month" is "Month" + the hint, not an exact match —
    // per the brief's escape hatch, target the control via the label wrapper.
    fireEvent.change(screen.getByText("Month").closest("label")!.querySelector("input")!, {
      target: { value: "2026-07" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create draft charge" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "charge-1" })));
    const call = apiFetch.mock.calls.find((c) => c[0] === "/billing/charges");
    const body = JSON.parse(call![1].body as string);
    expect(body).toMatchObject({
      partyId: "party-1",
      tenancyId: "ten-1",
      unitId: "unit-1",
      chargeType: "rental",
      categoryId: "cat-rental",
      dueDate: "2026-07-01",
      amount: "1500",
      currency: "MYR",
    });
    expect(body.chargeNumber).toMatch(/^CHG-\d{8}-[A-Z0-9]{4}$/);
  });
});

describe("ChargeForm (flag DARK)", () => {
  // Local apps/web/.env sets VITE_ENABLE_PHASE2_BILLING_DOCS=true for dev,
  // which vitest also loads (same root cause documented in
  // tasks-board-page.test.tsx re: VITE_ENABLE_PHASE2_SPRINTS) — pin it false
  // so this suite exercises the legacy path regardless of the ambient .env.
  beforeEach(() => vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "false"));

  it("renders the legacy free-text charge-type input and never fetches categories", async () => {
    renderForm();
    expect(await screen.findByLabelText("Charge type")).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();
    expect(apiFetch.mock.calls.every((c) => !String(c[0]).startsWith("/charge-categories"))).toBe(true);
  });
});

describe("defaultChargeNumber", () => {
  it("keeps the tracker drawer's CHG-YYYYMMDD-XXXX shape", () => {
    expect(defaultChargeNumber()).toMatch(/^CHG-\d{8}-[A-Z0-9]{4}$/);
  });
});

// Spec2 R10a (Task 5) — on 409 DUPLICATE_CHARGE the form must show an inline
// "This charge already exists" affordance instead of a raw error toast.
// Legacy (flag-DARK) path exercised here since the dup-detection branch lives
// in onError, independent of the category-vs-free-text field rendering.
describe("ChargeForm duplicate-charge feedback (Spec2 R10a)", () => {
  beforeEach(() => vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "false"));

  async function fillAndSubmit() {
    await screen.findByLabelText("Charge type");
    fireEvent.change(screen.getByLabelText("Charge type"), { target: { value: "access_card" } });
    fireEvent.change(screen.getByLabelText("Amount (RM)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft charge" }));
  }

  it("shows 'This charge already exists' with a link targeting existingChargeId on 409 DUPLICATE_CHARGE", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing/charges") {
        return Promise.reject(
          new ApiError("DUPLICATE_CHARGE", 409, "DUPLICATE_CHARGE", {
            error: "DUPLICATE_CHARGE",
            existingChargeId: "11111111-1111-4111-8111-111111111111",
          }),
        );
      }
      return Promise.resolve({ data: [] });
    });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByText("This charge already exists.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "View the existing charge" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("shows the affordance without a broken link when existingChargeId is absent (fail-closed race path)", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing/charges") {
        return Promise.reject(
          new ApiError("DUPLICATE_CHARGE", 409, "DUPLICATE_CHARGE", { error: "DUPLICATE_CHARGE" }),
        );
      }
      return Promise.resolve({ data: [] });
    });
    renderForm();
    await fillAndSubmit();

    expect(await screen.findByText("This charge already exists.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View the existing charge" })).toBeNull();
    // No link element at all should reference the literal string "undefined".
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("clears a prior duplicate banner once a resubmit succeeds", async () => {
    const onCreated = vi.fn();
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing/charges") {
        return Promise.reject(
          new ApiError("DUPLICATE_CHARGE", 409, "DUPLICATE_CHARGE", {
            error: "DUPLICATE_CHARGE",
            existingChargeId: "11111111-1111-4111-8111-111111111111",
          }),
        );
      }
      return Promise.resolve({ data: [] });
    });
    renderForm({ onCreated });
    await fillAndSubmit();
    expect(await screen.findByText("This charge already exists.")).toBeTruthy();

    // Admin edits the amount and retries — this time the API accepts it.
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing/charges") return Promise.resolve({ id: "charge-2" });
      return Promise.resolve({ data: [] });
    });
    fireEvent.change(screen.getByLabelText("Amount (RM)"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft charge" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "charge-2" })));
    expect(screen.queryByText("This charge already exists.")).toBeNull();
  });

  it("does not show the affordance for a plain successful create (no prior duplicate)", async () => {
    const onCreated = vi.fn();
    renderForm({ onCreated });
    await fillAndSubmit();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "charge-1" })));
    expect(screen.queryByText("This charge already exists.")).toBeNull();
  });

  it("falls through to toast.error (no dup affordance) for a plain 500", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing/charges") return Promise.reject(new ApiError("Server error.", 500));
      return Promise.resolve({ data: [] });
    });
    renderForm();
    await fillAndSubmit();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Server error."));
    expect(screen.queryByText("This charge already exists.")).toBeNull();
  });

  it("falls through to toast.error (no dup affordance) for a 409 that isn't DUPLICATE_CHARGE shaped", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/billing/charges") {
        return Promise.reject(new ApiError("Conflict.", 409, undefined, { error: "SOME_OTHER_CONFLICT" }));
      }
      return Promise.resolve({ data: [] });
    });
    renderForm();
    await fillAndSubmit();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Conflict."));
    expect(screen.queryByText("This charge already exists.")).toBeNull();
  });
});
