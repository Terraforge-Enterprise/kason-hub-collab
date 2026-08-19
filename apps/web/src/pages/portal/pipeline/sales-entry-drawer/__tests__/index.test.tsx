import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesEntryDrawer } from "../index";

const mockCreate = vi.fn();
const mockListProjects = vi.fn();
const mockListPackages = vi.fn();
const mockSearchOwners = vi.fn();

vi.mock("@/api/portal-sales-entries", () => ({
  createSalesEntry: (p: any) => mockCreate(p),
}));
vi.mock("@/api/portal-sales", () => ({
  listPortalProjects: () => mockListProjects(),
}));
vi.mock("@/api/portal-renovation-claims", () => ({
  listPackages: () => mockListPackages(),
}));
vi.mock("@/api/portal-owners", () => ({
  searchPortalOwners: (q: string) => mockSearchOwners(q),
  createPortalOwner: vi.fn(),
}));

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SalesEntryDrawer open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockCreate.mockReset();
  mockListProjects.mockResolvedValue({ data: [{ id: "p1", name: "Tower X", developer: "Dev", status: "active" }] });
  mockListPackages.mockResolvedValue([]);
  mockSearchOwners.mockResolvedValue({ data: [] });
});

describe("SalesEntryDrawer", () => {
  it("renders all four sections", async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByText(/Project \+ Unit/i)).toBeInTheDocument());
    expect(screen.getAllByText(/Sale/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Property profile/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Renovation/).length).toBeGreaterThan(0);
  });

  it("renders the existing project dropdown", async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByText("Tower X · Dev")).toBeInTheDocument());
  });

  it("Submit button shows the gold label", async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByRole("button", { name: /Submit Entry/i })).toBeInTheDocument());
  });
});
