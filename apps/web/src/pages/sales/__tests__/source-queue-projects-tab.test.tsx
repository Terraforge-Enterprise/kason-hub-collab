import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceQueueProjectsTab } from "../source-queue-projects-tab";

const mockListPending = vi.fn();
const mockVerify = vi.fn();
const mockReject = vi.fn();

vi.mock("@/api/projects-verification", () => ({
  listPendingVerification: () => mockListPending(),
  verifyProject: (id: string) => mockVerify(id),
  rejectProject: (id: string, note: string) => mockReject(id, note),
}));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SourceQueueProjectsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockListPending.mockReset();
  mockVerify.mockReset();
  mockReject.mockReset();
});

describe("SourceQueueProjectsTab", () => {
  it("renders the pending projects list", async () => {
    mockListPending.mockResolvedValue({
      data: [
        { id: "p1", name: "Tower X", developer: "Dev Y", city: "KL", expectedHandover: null, notes: null, createdAt: "2026-04-30T00:00:00Z", createdById: "u1" },
      ],
    });
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Tower X")).toBeInTheDocument();
    });
    expect(screen.getByText(/Dev Y/)).toBeInTheDocument();
  });

  it("shows empty state when no pending projects", async () => {
    mockListPending.mockResolvedValue({ data: [] });
    renderTab();
    await waitFor(() => {
      expect(screen.getByText(/No pending projects/i)).toBeInTheDocument();
    });
  });

  it("verify button calls verifyProject", async () => {
    mockListPending.mockResolvedValue({
      data: [{ id: "p1", name: "Tower X", developer: "Dev Y", city: null, expectedHandover: null, notes: null, createdAt: "2026-04-30T00:00:00Z", createdById: null }],
    });
    mockVerify.mockResolvedValue({ data: { id: "p1", status: "active" } });
    renderTab();
    await waitFor(() => screen.getByText("Tower X"));
    await userEvent.click(screen.getByRole("button", { name: /^verify$/i }));
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith("p1"));
  });
});
