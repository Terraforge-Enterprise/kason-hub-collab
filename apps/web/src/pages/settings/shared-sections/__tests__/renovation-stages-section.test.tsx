import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RenovationStagesSection } from "../renovation-stages-section";

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/api/renovation-stages", () => ({
  listRenovationStages: () => mockList(),
  createRenovationStage: (input: any) => mockCreate(input),
  updateRenovationStage: (id: string, input: any) => mockUpdate(id, input),
  reorderRenovationStages: vi.fn().mockResolvedValue({ data: { count: 0 } }),
}));

function renderSection(canWrite = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RenovationStagesSection canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
});

describe("RenovationStagesSection", () => {
  it("lists stages from the API", async () => {
    mockList.mockResolvedValue({
      data: [
        { id: "s1", key: "demo", label: "Demolition", description: null, sortOrder: 1, archived: false, organizationId: "o1", createdAt: "", updatedAt: "" },
        { id: "s2", key: "wiring", label: "Wiring", description: null, sortOrder: 2, archived: false, organizationId: "o1", createdAt: "", updatedAt: "" },
      ],
    });
    renderSection();
    await waitFor(() => expect(screen.getByDisplayValue("Demolition")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Wiring")).toBeInTheDocument();
  });

  it("create stage flow calls createRenovationStage", async () => {
    mockList.mockResolvedValue({ data: [] });
    mockCreate.mockResolvedValue({ data: { id: "new1" } });
    renderSection();
    await waitFor(() => screen.getByPlaceholderText(/Stage label/i));
    await userEvent.type(screen.getByPlaceholderText(/Stage label/i), "Painting");
    await userEvent.click(screen.getByRole("button", { name: /Add stage/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ label: "Painting" })));
  });

  it("hides write controls when canWrite=false", async () => {
    mockList.mockResolvedValue({
      data: [
        { id: "s1", key: "demo", label: "Demolition", description: null, sortOrder: 1, archived: false, organizationId: "o1", createdAt: "", updatedAt: "" },
      ],
    });
    renderSection(false);
    await waitFor(() => screen.getByText("Demolition"));
    expect(screen.queryByPlaceholderText(/Stage label/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add stage/i })).not.toBeInTheDocument();
  });
});
