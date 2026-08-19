import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Owner Documents restyle — design-standard header + search + EmptyState +
// styled rows + formatDateMY. Native matchers only (jest-dom not asserted).

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  PortalApiError: class PortalApiError extends Error {},
}));

import OwnerDocsPage from "../owner-docs";

function renderPage(docs: unknown[]) {
  portalApiFetch.mockResolvedValue({ data: docs });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OwnerDocsPage />
    </QueryClientProvider>,
  );
}

const DOCS = [
  { id: "d1", title: "June 2026 Statement", fileType: "PDF", createdAt: "2026-07-01" },
  { id: "d2", title: "Annual Tax Summary", fileType: "PDF", createdAt: "2026-01-15" },
];

beforeEach(() => portalApiFetch.mockReset());

describe("OwnerDocsPage (restyle)", () => {
  it("renders rows with title + fileType + formatDateMY date (not raw ISO)", async () => {
    renderPage(DOCS);
    expect(await screen.findByText("June 2026 Statement")).toBeTruthy();
    expect(screen.getByText(/1 Jul 2026/)).toBeTruthy(); // formatDateMY, not "2026-07-01"
    expect(screen.queryByText(/2026-07-01/)).toBeNull();
  });

  it("empty → EmptyState with 'No documents yet'", async () => {
    renderPage([]);
    expect(await screen.findByText("No documents yet")).toBeTruthy();
  });

  it("search filters the list client-side by title", async () => {
    renderPage(DOCS);
    await screen.findByText("June 2026 Statement");
    fireEvent.change(screen.getByLabelText(/search documents/i), { target: { value: "tax" } });
    await waitFor(() => expect(screen.queryByText("June 2026 Statement")).toBeNull());
    expect(screen.getByText("Annual Tax Summary")).toBeTruthy();
  });
});
