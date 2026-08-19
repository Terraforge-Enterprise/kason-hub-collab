import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mutateMock = vi.fn();
vi.mock("@/api/charge-categories", () => ({
  useDocumentSeries: () => ({
    data: {
      items: [
        { id: "s-dep", code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true, updatedAt: "2026-07-02T00:00:00.000Z" },
        { id: "s-ivten", code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: true, active: true, updatedAt: "2026-07-02T00:00:00.000Z" },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useUpdateDocumentSeries: () => ({ mutate: mutateMock, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import DocumentSeriesSettingsPage from "../document-series-section";

beforeEach(() => mutateMock.mockReset());

describe("DocumentSeriesSettingsPage", () => {
  it("renders one card per series with a live number preview", () => {
    render(<DocumentSeriesSettingsPage />);
    expect(screen.getByText("Document Series")).toBeTruthy();
    expect(screen.getByText("DEP")).toBeTruthy();
    expect(screen.getByText(/DEP-0001/)).toBeTruthy(); // padding 4, no year
    const year = new Date().getFullYear();
    expect(screen.getByText(new RegExp(`IVTEN-${year}-0001`))).toBeTruthy(); // includeYear
  });

  it("saves an edited prefix with the optimistic-concurrency token", async () => {
    render(<DocumentSeriesSettingsPage />);
    const prefixInputs = screen.getAllByLabelText("Prefix") as HTMLInputElement[];
    fireEvent.change(prefixInputs[0], { target: { value: "DEPX" } });
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons[0]);
    await waitFor(() => expect(mutateMock).toHaveBeenCalled());
    expect(mutateMock.mock.calls[0][0]).toMatchObject({
      id: "s-dep",
      prefix: "DEPX",
      expectedUpdatedAt: "2026-07-02T00:00:00.000Z",
    });
  });
});
