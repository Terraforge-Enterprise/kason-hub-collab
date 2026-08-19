import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Mocks (mirrors owner-billing-section.test.tsx conventions — no msw) ──────

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { apiFetch } from "@/lib/api-client";
import { FeeConfigDrawer, type OwnerOption } from "../fee-config-drawer";

const apiFetchMock = vi.mocked(apiFetch);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LOCKED_OWNER: OwnerOption = { id: "owner-77", displayName: "Test Owner Corp" };

function renderDrawer(props: Partial<React.ComponentProps<typeof FeeConfigDrawer>> = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <FeeConfigDrawer
        open
        onClose={vi.fn()}
        mode="create"
        owners={[]}
        properties={[]}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockImplementation(
    () =>
      Promise.resolve({ data: { items: [], limit: 20, offset: 0 } }) as ReturnType<
        typeof apiFetch
      >,
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FeeConfigDrawer — lockedOwner (owner-detail affordance, Task 5)", () => {
  it("renders the owner as read-only text, not a select, when lockedOwner is set", async () => {
    renderDrawer({ lockedOwner: LOCKED_OWNER });

    expect(await screen.findByText("Test Owner Corp")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Owner" })).not.toBeInTheDocument();
  });

  it("still renders the owner select when lockedOwner is absent (existing caller unaffected)", async () => {
    renderDrawer({ owners: [{ id: "owner-1", displayName: "Some Owner" }] });

    expect(await screen.findByRole("combobox", { name: "Owner" })).toBeInTheDocument();
    expect(screen.getByText("Select an owner…")).toBeInTheDocument();
  });

  it("create mode + lockedOwner: submitting posts the locked owner's id", async () => {
    apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        return Promise.resolve({ data: { id: "fc-new" } }) as ReturnType<typeof apiFetch>;
      }
      return Promise.resolve({ data: { items: [], limit: 20, offset: 0 } }) as ReturnType<
        typeof apiFetch
      >;
    });

    renderDrawer({ lockedOwner: LOCKED_OWNER });

    fireEvent.change(await screen.findByLabelText(/Fee value/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Create config" }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
      expect(call).toBeTruthy();
    });
    const call = apiFetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.ownerPartyId).toBe("owner-77");
  });
});
