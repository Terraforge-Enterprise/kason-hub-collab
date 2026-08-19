import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PortalOwnerPicker } from "../portal-owner-picker";

const mockSearch = vi.fn();
const mockCreate = vi.fn();

vi.mock("@/api/portal-owners", () => ({
  searchPortalOwners: (q: string) => mockSearch(q),
  createPortalOwner: (input: any) => mockCreate(input),
}));

function renderPicker(props: Partial<React.ComponentProps<typeof PortalOwnerPicker>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PortalOwnerPicker
        value={null}
        displayName=""
        onChange={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSearch.mockReset();
  mockCreate.mockReset();
});

describe("PortalOwnerPicker", () => {
  it("shows search results when typing", async () => {
    mockSearch.mockResolvedValue({
      data: [
        { id: "o1", displayName: "John Tan", primaryPhone: "+60123", primaryEmail: null },
      ],
    });
    renderPicker();
    await userEvent.type(screen.getByPlaceholderText(/search owner/i), "John");
    await waitFor(() => expect(screen.getByText("John Tan")).toBeInTheDocument());
  });

  it("calls onChange with selected owner", async () => {
    const onChange = vi.fn();
    mockSearch.mockResolvedValue({
      data: [{ id: "o1", displayName: "John Tan", primaryPhone: null, primaryEmail: null }],
    });
    renderPicker({ onChange });
    await userEvent.type(screen.getByPlaceholderText(/search owner/i), "John");
    await waitFor(() => screen.getByText("John Tan"));
    await userEvent.click(screen.getByText("John Tan"));
    expect(onChange).toHaveBeenCalledWith({
      partyId: "o1",
      displayName: "John Tan",
    });
  });

  it("opens inline create form on '+ Add new owner' click", async () => {
    mockSearch.mockResolvedValue({ data: [] });
    renderPicker();
    await userEvent.type(screen.getByPlaceholderText(/search owner/i), "Brand New");
    await waitFor(() => screen.getByRole("button", { name: /add new owner/i }));
    await userEvent.click(screen.getByRole("button", { name: /add new owner/i }));
    expect(screen.getByPlaceholderText(/full name/i)).toBeInTheDocument();
  });

  it("creates owner and triggers onChange", async () => {
    const onChange = vi.fn();
    mockSearch.mockResolvedValue({ data: [] });
    mockCreate.mockResolvedValue({
      data: { id: "new-o", displayName: "Jane Lee", primaryPhone: null, primaryEmail: null },
    });
    renderPicker({ onChange });
    await userEvent.type(screen.getByPlaceholderText(/search owner/i), "Jane");
    await waitFor(() => screen.getByRole("button", { name: /add new owner/i }));
    await userEvent.click(screen.getByRole("button", { name: /add new owner/i }));
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Jane" })));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ partyId: "new-o", displayName: "Jane Lee" }));
  });
});
