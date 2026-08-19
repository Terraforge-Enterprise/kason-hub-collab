import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Item 1 (FPX ops polish) — the portal payments page shows a dismissible banner
// when the gateway returns the payer with ?fpx=success|failed, then strips the
// param. Native matchers only (jest-dom isn't wired in the worktree vitest env).

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  PortalApiError: class PortalApiError extends Error {},
}));

import PortalPaymentsPage from "../payments";

const SUCCESS_TEXT = "Your payment was received.";
const FAILED_TEXT = "Your payment didn't complete — please try again.";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <PortalPaymentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  portalApiFetch.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
  });
});

describe("PortalPaymentsPage — FPX return banner", () => {
  it("?fpx=success → shows the success banner", async () => {
    renderAt("/portal/payments?fpx=success");
    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
  });

  it("?fpx=failed → shows the failure banner", async () => {
    renderAt("/portal/payments?fpx=failed");
    expect(await screen.findByText(FAILED_TEXT)).toBeTruthy();
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
  });

  it("no ?fpx param → shows no banner", async () => {
    renderAt("/portal/payments");
    // Let the page settle (header always renders).
    expect(await screen.findByText("Payment History")).toBeTruthy();
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
    expect(screen.queryByText(FAILED_TEXT)).toBeNull();
  });

  it("dismiss button hides the banner", async () => {
    renderAt("/portal/payments?fpx=success");
    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss notification/i }));
    await waitFor(() => expect(screen.queryByText(SUCCESS_TEXT)).toBeNull());
  });
});
