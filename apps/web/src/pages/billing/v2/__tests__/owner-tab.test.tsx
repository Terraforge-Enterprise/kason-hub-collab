import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/lib/feature-flags", () => ({ isPhase2FlagEnabled: () => true }));

import { OwnerBillingTab } from "../owner-tab";

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>,
  );
};

const STMT_ROW = {
  id: "s1", chargeNumber: "OSC-202607-aa81-0001", partyName: "Dato' Razak bin Abdullah",
  tenancyCode: null, chargeType: "management_fee", categoryLabel: "Management fee",
  status: "draft", displayStatus: "on_statement", dueDate: "2026-07-01T00:00:00.000Z",
  amount: 220, outstandingAmount: 220, currency: "MYR", documentId: null, documentNumber: null,
};

const DATA = {
  month: "2026-07", groupBy: "statement",
  groups: [
    {
      key: "statement:inv1", kind: "statement", label: "OS-202607-aa816145",
      propertyName: "", apartmentId: null, subtitle: "Dato' Razak bin Abdullah", statementStatus: "approved",
      ivownDocumentId: "doc1", ivownDocumentNumber: "IVOWN-0007",
      totals: { amount: 910, outstanding: 910, chargeCount: 8 },
      charges: [STMT_ROW],
    },
    {
      key: "unattached", kind: "unattached", label: "Unattached", propertyName: "",
      apartmentId: null, subtitle: "", statementStatus: null, ivownDocumentId: null, ivownDocumentNumber: null,
      totals: { amount: 100, outstanding: 100, chargeCount: 1 },
      charges: [{ ...STMT_ROW, id: "s2", chargeNumber: "CLN-202607-aa81-0001", displayStatus: "draft", status: "draft" }],
    },
  ],
};

beforeEach(() => apiFetchMock.mockReset().mockResolvedValue(DATA));

describe("OwnerBillingTab", () => {
  it("statement groups: OS number, owner, status pill, IVOWN number, on-statement pills", async () => {
    wrap(<OwnerBillingTab month="2026-07" />);
    await waitFor(() => expect(screen.getByText("OS-202607-aa816145")).toBeTruthy());
    expect(screen.getAllByText(/Razak/).length).toBeGreaterThan(0);
    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.getByText(/IVOWN-0007/)).toBeTruthy();
    expect(screen.getByText(/on statement/i)).toBeTruthy();
    expect(screen.getByText("Unattached")).toBeTruthy();
  });
  it("no post: statement child ⋯ menu has no Post item", async () => {
    wrap(<OwnerBillingTab month="2026-07" />);
    await waitFor(() => expect(screen.getByText("OSC-202607-aa81-0001")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /charge actions for OSC-202607-aa81-0001/i }));
    expect(screen.queryByRole("menuitem", { name: /post/i })).toBeNull();
  });
});
