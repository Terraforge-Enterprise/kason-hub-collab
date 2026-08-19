import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Item 3 (FPX ops polish) — admin in-flight FPX section: lists stuck attempts and
// cancels one via POST /payments/fpx/:id/cancel. Native matchers only.

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { InFlightFpxSection } from "../in-flight-fpx-section";

const ROW = {
  id: "pay-1",
  paymentNumber: "PAY-INFLIGHT-1",
  partyName: "Alice Tenant",
  amount: 900,
  currency: "MYR",
  createdAt: "2026-06-27T00:00:00.000Z",
  ageMinutes: 95,
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InFlightFpxSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe("InFlightFpxSection", () => {
  it("lists an in-flight FPX payment with payer + amount + age", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/payments/fpx/in-flight") return Promise.resolve({ data: [ROW] });
      return Promise.resolve({});
    });
    renderSection();

    expect(await screen.findByText("In-flight FPX payments")).toBeTruthy();
    expect(screen.getByText("Alice Tenant")).toBeTruthy();
    expect(screen.getByText("PAY-INFLIGHT-1")).toBeTruthy();
    expect(screen.getByText("1h 35m")).toBeTruthy(); // 95 min
  });

  it("renders nothing when there are no in-flight payments", async () => {
    apiFetch.mockResolvedValue({ data: [] });
    const { container } = renderSection();
    // Wait a tick for the query to resolve, then assert the section is absent.
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("In-flight FPX payments")).toBeNull());
    expect(container.textContent).toBe("");
  });

  it("Cancel posts to /payments/fpx/:id/cancel", async () => {
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/payments/fpx/in-flight" && !init) return Promise.resolve({ data: [ROW] });
      if (path === "/payments/fpx/pay-1/cancel" && init?.method === "POST") return Promise.resolve({ id: "pay-1", status: "expired" });
      return Promise.resolve({ data: [] });
    });
    renderSection();

    const cancelBtn = await screen.findByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      const call = apiFetch.mock.calls.find(
        ([p, init]) => p === "/payments/fpx/pay-1/cancel" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
  });
});
