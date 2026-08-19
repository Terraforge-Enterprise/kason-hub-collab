import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi, test, expect, beforeEach } from "vitest";
import DashboardPage from "./index";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {},
}));

function renderPage() {
  // retry:false so the error state is reached immediately in the test; the real
  // app uses a backed-off retry policy (see main.tsx) to ride out cold starts.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

test("renders skeleton without crashing while loading", () => {
  apiFetch.mockReturnValue(new Promise(() => {})); // never resolves — stays pending
  renderPage();
  expect(document.body).toBeTruthy();
});

test("failed load shows a recoverable error with a Retry button, not a dead-end", async () => {
  apiFetch.mockRejectedValue(new Error("cold start"));
  renderPage();
  // On-brand recovery copy replaces the old hard "Failed to load dashboard".
  expect(await screen.findByText(/couldn't load your dashboard/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
});

test("Try again re-fetches the dashboard", async () => {
  apiFetch.mockRejectedValue(new Error("cold start"));
  renderPage();
  await screen.findByText(/couldn't load your dashboard/i);
  const before = apiFetch.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
  await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(before));
});
