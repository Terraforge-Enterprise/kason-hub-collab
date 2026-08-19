// P4 Task 6: Units tab — org-wide unit-first front door.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
import { UnitsTab } from "../units-tab";

const apiFetchMock = vi.mocked(apiFetch);

const ROW_A = {
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  propertyId: "prop-1",
  propertyName: "Areca Residences",
  ownerPartyId: "owner-1",
  ownerName: "Dato' Razak",
  occupancy: { activeTenancies: 2 },
  figures: { income: "1500.00", expenses: "150.00", netPayout: "1350.00" },
  statement: { id: "stmt-1", status: "approved" },
  openDocuments: 3,
};
const ROW_UNASSIGNED = {
  apartmentId: null,
  unitCode: null,
  propertyId: "prop-1",
  propertyName: "Areca Residences",
  ownerPartyId: null,
  ownerName: null,
  occupancy: { activeTenancies: 0 },
  figures: { income: "0.00", expenses: "50.00", netPayout: "-50.00" },
  statement: null,
  openDocuments: 0,
};

function stub(items: unknown[] = [ROW_A, ROW_UNASSIGNED], total = 1) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/inventory/properties") {
      return Promise.resolve({ data: [{ id: "prop-1", name: "Areca Residences" }] }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/units-summary")) {
      return Promise.resolve({ data: { items, total } }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: {} }) as ReturnType<typeof apiFetch>;
  });
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tenancy/owner-ledger"]}>
        <UnitsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const settleDebounce = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
});

describe("UnitsTab (P4)", () => {
  it("renders unit rows with owner, occupancy, figures, statement chip and open docs", async () => {
    stub();
    renderTab();
    expect(await screen.findByText("A-10-04")).toBeInTheDocument();
    expect(screen.getByText("Dato' Razak")).toBeInTheDocument();
    expect(screen.getByText(/1,350\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Approved/i)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders the Unassigned residual row as non-clickable", async () => {
    stub();
    renderTab();
    const row = await screen.findByRole("row", { name: /Unassigned · Areca Residences/i });
    fireEvent.click(row);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates to the unit workspace when a real unit row is clicked", async () => {
    stub();
    renderTab();
    fireEvent.click(await screen.findByRole("row", { name: /Unit A-10-04/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/tenancy/owner-ledger/unit/apt-1");
  });

  it("sends the debounced search as the server-side q param", async () => {
    stub();
    renderTab();
    await screen.findByText("A-10-04");
    fireEvent.change(screen.getByRole("textbox", { name: /Search units/i }), {
      target: { value: "A-10" },
    });
    await settleDebounce();
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("units-summary") && c[0].includes("q=A-10"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("property rail click scopes the query by propertyId", async () => {
    stub();
    renderTab();
    await screen.findByText("A-10-04");
    fireEvent.click(screen.getAllByRole("button", { name: /Areca Residences/i })[0]!);
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("units-summary") && c[0].includes("propertyId=prop-1"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("month picker changes the month param (first-of-month)", async () => {
    stub();
    renderTab();
    await screen.findByText("A-10-04");
    fireEvent.change(screen.getByLabelText(/Ledger month/i), { target: { value: "2026-05" } });
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("month=2026-05-01"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("shows the empty state when there are no units", async () => {
    stub([], 0);
    renderTab();
    expect(await screen.findByText(/No units found/i)).toBeInTheDocument();
  });
});
