import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChangePasswordPage from "../change-password-page";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));
// The page signs out (clearAuth) on success; provide a no-op auth context.
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ clearAuth: vi.fn() }) }));
import { apiFetch } from "@/lib/api-client";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/change-password"]}>
        <ChangePasswordPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChangePasswordPage (admin)", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("rejects new password shorter than 6 chars", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-temp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "short");
    await userEvent.type(screen.getByLabelText(/confirm/i), "short");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    expect(await screen.findByText(/at least 6 characters/i)).toBeInTheDocument();
  });

  it("accepts a 6-character password", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, message: "ok" } as never);
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-tmp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "abcd12");
    await userEvent.type(screen.getByLabelText(/confirm/i), "abcd12");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    expect(screen.queryByText(/at least 6 characters/i)).toBeNull();
  });

  it("rejects when confirm does not match", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-temp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "long-password-1234");
    await userEvent.type(screen.getByLabelText(/confirm/i), "different-1234567");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
  });

  it("calls /auth/change-password on success", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, message: "ok" } as never);
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-temp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "long-password-1234");
    await userEvent.type(screen.getByLabelText(/confirm/i), "long-password-1234");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/auth/change-password",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
