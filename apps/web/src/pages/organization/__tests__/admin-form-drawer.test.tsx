import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminFormDrawer } from "../admin-form-drawer";

vi.mock("@/api/users", () => ({
  useCreateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateUser: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  // Added 2026-05-23 — the drawer now sets a Party.uplineId after the User
  // patch lands, so this mutation hook has to exist in the mock surface.
  useSetPartyUpline: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminFormDrawer open mode="create" user={null} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("AdminFormDrawer — password validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects password shorter than 6 characters", async () => {
    renderDrawer();
    await userEvent.type(screen.getByLabelText(/full name/i), "Test User");
    await userEvent.type(screen.getByLabelText(/email/i), "test@example.com");
    await userEvent.type(screen.getByLabelText(/temporary password/i), "abc");
    await userEvent.click(screen.getByRole("button", { name: /create user/i }));
    expect(await screen.findByText(/at least 6 characters/i)).toBeInTheDocument();
  });

  it("accepts a 6-character password", async () => {
    renderDrawer();
    await userEvent.type(screen.getByLabelText(/full name/i), "Test User");
    await userEvent.type(screen.getByLabelText(/email/i), "test@example.com");
    await userEvent.type(screen.getByLabelText(/temporary password/i), "abcd12");
    await userEvent.click(screen.getByRole("button", { name: /create user/i }));
    expect(screen.queryByText(/at least 6 characters/i)).toBeNull();
  });
});
