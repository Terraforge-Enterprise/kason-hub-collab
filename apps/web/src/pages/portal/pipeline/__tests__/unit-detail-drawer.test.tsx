import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnitDetailDrawer } from "../unit-detail-drawer";

const mockGetDetail = vi.fn();
const mockFlipStage = vi.fn();
const mockMarkComplete = vi.fn();

vi.mock("@/api/portal-sales-units-detail", () => ({
  getPortalSalesUnitDetail: (id: string) => mockGetDetail(id),
}));
vi.mock("@/api/portal-renovation-progress", () => ({
  flipStageStatus: (...args: any[]) => mockFlipStage(...args),
  markRenovationComplete: (...args: any[]) => mockMarkComplete(...args),
}));

function renderDrawer(unitId = "u1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnitDetailDrawer unitId={unitId} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

const baseUnit = {
  id: "u1",
  unitNumber: "A-08-02",
  salesDate: "2026-04-01T00:00:00.000Z",
  purpose: "rent" as const,
  bedrooms: 2,
  bathrooms: 1,
  sourcingApproved: true,
  project: { id: "p1", name: "Aurora" },
  ownerParty: { id: "o1", displayName: "Tom Owner" },
};

beforeEach(() => {
  mockGetDetail.mockReset();
  mockFlipStage.mockReset();
  mockMarkComplete.mockReset();
});

describe("UnitDetailDrawer", () => {
  it("renders unit info and stages list when progress exists", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: {
        id: "rp-1",
        status: "on_going",
        startDate: "2026-04-02T00:00:00.000Z",
        expectedCompletion: null,
        actualCompletion: null,
        stages: [
          {
            stageProgressId: "sp-1",
            stageKey: "design",
            stageLabel: "Design",
            sortOrder: 1,
            status: "completed",
          },
          {
            stageProgressId: "sp-2",
            stageKey: "demolition",
            stageLabel: "Demolition",
            sortOrder: 2,
            status: "in_progress",
          },
        ],
      },
    });
    renderDrawer();
    await waitFor(() => expect(screen.getByText(/Aurora/)).toBeInTheDocument());
    expect(screen.getByText(/A-08-02/)).toBeInTheDocument();
    expect(screen.getByText(/Tom Owner/)).toBeInTheDocument();
    // Stage labels appear in both chips and the stage rows.
    expect(screen.getAllByText(/Design/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Demolition/).length).toBeGreaterThan(0);
  });

  it("renders 'No renovation tracked' when progress is null", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: null,
    });
    renderDrawer();
    await waitFor(() =>
      expect(screen.getByText(/No renovation tracked/i)).toBeInTheDocument(),
    );
  });

  it("disables Mark renovation complete when not all stages are completed", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: {
        id: "rp-1",
        status: "on_going",
        startDate: null,
        expectedCompletion: null,
        actualCompletion: null,
        stages: [
          {
            stageProgressId: "sp-1",
            stageKey: "design",
            stageLabel: "Design",
            sortOrder: 1,
            status: "completed",
          },
          {
            stageProgressId: "sp-2",
            stageKey: "demolition",
            stageLabel: "Demolition",
            sortOrder: 2,
            status: "in_progress",
          },
        ],
      },
    });
    renderDrawer();
    const btn = await screen.findByRole("button", {
      name: /Mark renovation complete/i,
    });
    expect(btn).toBeDisabled();
  });

  it("opens the ConfirmAlert when clicking Mark renovation complete", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: {
        id: "rp-1",
        status: "on_going",
        startDate: null,
        expectedCompletion: null,
        actualCompletion: null,
        stages: [
          {
            stageProgressId: "sp-1",
            stageKey: "design",
            stageLabel: "Design",
            sortOrder: 1,
            status: "completed",
          },
          {
            stageProgressId: "sp-2",
            stageKey: "demolition",
            stageLabel: "Demolition",
            sortOrder: 2,
            status: "completed",
          },
        ],
      },
    });
    renderDrawer();
    const btn = await screen.findByRole("button", {
      name: /Mark renovation complete/i,
    });
    expect(btn).toBeEnabled();
    const user = userEvent.setup();
    await user.click(btn);
    await waitFor(() =>
      expect(
        screen.getByText(/all stages are marked completed/i),
      ).toBeInTheDocument(),
    );
    // Lock the contract: a real alertdialog opens (not just inline text).
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("hides the Mark Complete button and shows completed message when progress.status=completed (with date)", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: {
        id: "rp-1",
        status: "completed",
        startDate: "2026-04-02T00:00:00.000Z",
        expectedCompletion: null,
        actualCompletion: "2026-04-30T08:15:00.000Z",
        stages: [
          {
            stageProgressId: "sp-1",
            stageKey: "design",
            stageLabel: "Design",
            sortOrder: 1,
            status: "completed",
          },
        ],
      },
    });
    renderDrawer();
    await waitFor(() =>
      expect(
        screen.getByText(/Renovation completed on 2026-04-30/),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Mark renovation complete/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Mark Complete button and shows generic completed message when actualCompletion is null", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: {
        id: "rp-1",
        status: "completed",
        startDate: null,
        expectedCompletion: null,
        actualCompletion: null,
        stages: [
          {
            stageProgressId: "sp-1",
            stageKey: "design",
            stageLabel: "Design",
            sortOrder: 1,
            status: "completed",
          },
        ],
      },
    });
    renderDrawer();
    await waitFor(() =>
      expect(screen.getByText(/Renovation completed\./)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Mark renovation complete/i }),
    ).not.toBeInTheDocument();
  });

  it("uses the new Segmented option labels: Pending / On going / Done", async () => {
    mockGetDetail.mockResolvedValue({
      ...baseUnit,
      renovationProgress: {
        id: "rp-1",
        status: "on_going",
        startDate: null,
        expectedCompletion: null,
        actualCompletion: null,
        stages: [
          {
            stageProgressId: "sp-1",
            stageKey: "design",
            stageLabel: "Design",
            sortOrder: 1,
            status: "in_progress",
          },
        ],
      },
    });
    renderDrawer();
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Pending" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("radio", { name: "On going" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Done" })).toBeInTheDocument();
  });
});
