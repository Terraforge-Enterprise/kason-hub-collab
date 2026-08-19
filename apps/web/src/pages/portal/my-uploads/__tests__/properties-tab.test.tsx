/**
 * Component tests for the Properties tab of My Uploads.
 * Spec: docs/superpowers/specs/2026-05-21-agent-property-amendment-design.md §4.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const mockListOwn = vi.fn();

vi.mock("@/api/portal-inventory", () => ({
  listOwnPortalProperties: () => mockListOwn(),
}));

import { PropertiesTab } from "../properties-tab";
import type { PortalOwnPropertyListRow } from "@/api/portal-inventory";

function makeRow(
  state: PortalOwnPropertyListRow["submissionState"],
  overrides: Partial<PortalOwnPropertyListRow> = {},
): PortalOwnPropertyListRow {
  return {
    id: `prop-${state}`,
    name: `Submission ${state}`,
    propertyCode: `TC-${state.slice(0, 3).toUpperCase()}`,
    propertyType: "Condominium",
    submissionState: state,
    amendmentNote:
      state === "needs_amendment" ? "Fix the postcode" :
      state === "rejected" ? "Duplicate of TC-001" : null,
    approvedPropertyId: state === "approved" ? "approved-id" : null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    ...overrides,
  };
}

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PropertiesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockListOwn.mockReset();
});

describe("PropertiesTab", () => {
  it("renders empty state when there are no submissions", async () => {
    mockListOwn.mockResolvedValue([]);

    renderTab();

    expect(
      await screen.findByText(/No property submissions yet/i),
    ).toBeInTheDocument();
  });

  it("renders sections in the per-spec order: pending → needs_amendment → approved → rejected → withdrawn", async () => {
    mockListOwn.mockResolvedValue([
      makeRow("withdrawn"),
      makeRow("rejected"),
      makeRow("approved"),
      makeRow("needs_amendment"),
      makeRow("pending"),
    ]);

    renderTab();

    const sections = await screen.findAllByTestId(/^properties-section-/);
    const order = sections.map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "properties-section-pending",
      "properties-section-needs_amendment",
      "properties-section-approved",
      "properties-section-rejected",
      "properties-section-withdrawn",
    ]);
  });

  it("suppresses sections with zero rows", async () => {
    mockListOwn.mockResolvedValue([makeRow("pending")]);

    renderTab();

    expect(await screen.findByTestId("properties-section-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("properties-section-needs_amendment")).not.toBeInTheDocument();
    expect(screen.queryByTestId("properties-section-approved")).not.toBeInTheDocument();
  });

  it("surfaces the admin amendment note inline on needs_amendment rows", async () => {
    mockListOwn.mockResolvedValue([makeRow("needs_amendment")]);

    renderTab();

    const section = await screen.findByTestId("properties-section-needs_amendment");
    expect(within(section).getByText(/Fix the postcode/)).toBeInTheDocument();
    expect(within(section).getByText(/Admin note:/i)).toBeInTheDocument();
  });

  it("surfaces the rejection reason on rejected rows", async () => {
    mockListOwn.mockResolvedValue([makeRow("rejected")]);

    renderTab();

    const section = await screen.findByTestId("properties-section-rejected");
    expect(within(section).getByText(/Duplicate of TC-001/)).toBeInTheDocument();
    expect(within(section).getByText(/Rejection reason:/i)).toBeInTheDocument();
  });

  it("shows Edit & resubmit + Withdraw on needs_amendment rows", async () => {
    mockListOwn.mockResolvedValue([makeRow("needs_amendment")]);

    renderTab();

    const section = await screen.findByTestId("properties-section-needs_amendment");
    expect(within(section).getByRole("button", { name: /Edit & resubmit/i })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: /Withdraw/i })).toBeInTheDocument();
  });

  it("shows only Withdraw on pending rows (no edit affordance)", async () => {
    mockListOwn.mockResolvedValue([makeRow("pending")]);

    renderTab();

    const section = await screen.findByTestId("properties-section-pending");
    expect(within(section).queryByRole("button", { name: /Edit & resubmit/i })).not.toBeInTheDocument();
    expect(within(section).getByRole("button", { name: /Withdraw/i })).toBeInTheDocument();
  });

  it("shows View property link on approved rows", async () => {
    mockListOwn.mockResolvedValue([makeRow("approved")]);

    renderTab();

    const section = await screen.findByTestId("properties-section-approved");
    const link = within(section).getByRole("link", { name: /View property/i });
    expect(link).toHaveAttribute("href", "/portal/inventory?propertyId=approved-id");
  });

  it("renders rejected and withdrawn rows as read-only (no buttons)", async () => {
    mockListOwn.mockResolvedValue([makeRow("rejected"), makeRow("withdrawn")]);

    renderTab();

    const rejected = await screen.findByTestId("properties-section-rejected");
    const withdrawn = await screen.findByTestId("properties-section-withdrawn");
    expect(within(rejected).queryByRole("button")).not.toBeInTheDocument();
    expect(within(withdrawn).queryByRole("button")).not.toBeInTheDocument();
  });
});
