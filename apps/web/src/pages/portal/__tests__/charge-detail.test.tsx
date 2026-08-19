import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// charge-detail.tsx is the single-charge tenant payment surface. The
// multi-charge basket (pay.tsx) was already locked to full-outstanding
// (see pay.test.tsx "amount is locked to full outstanding"); this file locks
// the separate single-charge surface the same way: the amount is no longer
// editable, and it always submits the full outstanding balance.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import PortalChargeDetailPage from "../charge-detail";

// amount (gross) and outstandingAmount deliberately DIFFER — this is a
// partially-paid charge. A same-value fixture couldn't tell apart "sends
// charge.amount" from "sends charge.outstandingAmount"; this one can.
const CHARGE = {
  id: "c-1",
  chargeNumber: "CHG-001",
  chargeType: "rent",
  description: null,
  status: "partially_paid",
  dueDate: "2026-06-05T00:00:00.000Z",
  amount: 150,
  outstandingAmount: 90,
  currency: "MYR",
  createdAt: "2026-06-01T00:00:00.000Z",
};

function renderPage(initialEntry = "/portal/charges/c-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/portal/charges/:id" element={<PortalChargeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  navigate.mockReset();

  portalApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/charges/c-1" && !init?.method) {
      return Promise.resolve({ data: CHARGE });
    }
    if (path === "/charges/c-1/pay" && init?.method === "POST") {
      return Promise.resolve({ data: { id: "pay-1", paymentNumber: "PAY-TEST" } });
    }
    return Promise.resolve({ data: null });
  });
});

describe("PortalChargeDetailPage — amount is locked to full outstanding", () => {
  it("renders no editable amount input, shows the outstanding as static text, and submits the full outstanding amount", async () => {
    renderPage();

    const payButton = await screen.findByRole("button", { name: "Submit Payment" });
    fireEvent.click(payButton);

    // No editable number input for the amount once the pay form is open.
    expect(screen.queryByRole("spinbutton")).toBeNull();

    // The outstanding (90) renders as static text in the locked amount cell —
    // its own text node, not the "MYR 90.00" combined string used by the
    // pre-existing summary Row (getByText's default exact match can only hit
    // the dedicated locked cell). Because the fixture's gross `amount` (150)
    // differs from `outstandingAmount` (90), this assertion would fail if the
    // lock ever rendered the gross amount instead.
    expect(screen.getByText("90.00")).toBeTruthy();

    // Fill in the required Reference Number (no placeholder/label wiring on
    // this field, so select by input type: it's the lone <input type="text">
    // among the form's textboxes — Notes is a <textarea>, also role "textbox").
    const textboxes = screen.getAllByRole("textbox");
    const refInput = textboxes.find((el) => el.tagName === "INPUT") as HTMLInputElement;
    expect(refInput).toBeTruthy();
    fireEvent.change(refInput, { target: { value: "TXN-123" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit for Approval" }));

    await waitFor(() => {
      const call = portalApiFetch.mock.calls.find(
        ([p, init]) =>
          p === "/charges/c-1/pay" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      // Must equal the OUTSTANDING (90), not the gross `amount` (150) — the
      // fixture's gross/outstanding split is what lets this assertion catch
      // a regression that sends charge.amount instead.
      expect(body.amount).toBe(90);
    });
  });
});
