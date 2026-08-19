import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: "admin" } }),
}));

import { apiFetch } from "@/lib/api-client";
import UtilitiesSection from "../utilities-section";

const apiFetchMock = vi.mocked(apiFetch);

function stubApi(subsidyPerPax = "30.00") {
  apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
    if (options?.method === "PATCH") {
      return Promise.resolve({ subsidyPerPax }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/utility-billing-config") {
      return Promise.resolve({ subsidyPerPax }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({}) as ReturnType<typeof apiFetch>;
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings/utilities"]}>
        <UtilitiesSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubApi();
});

describe("UtilitiesSection", () => {
  it("renders the current subsidyPerPax value", async () => {
    renderPage();
    // Wait for the input to appear with the loaded value
    const input = await screen.findByRole("spinbutton");
    expect(input).toHaveValue(30);
  });

  it("Save triggers PATCH to /utility-billing-config", async () => {
    renderPage();
    await screen.findByRole("spinbutton");

    // Click Edit to enable editing
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    // Change the value
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "50.00" } });

    // Click Save
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/utility-billing-config",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });
});
