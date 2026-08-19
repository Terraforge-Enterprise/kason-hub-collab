import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChangePasswordPage from "../change-password-page";

vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  clearStoredAuth: vi.fn(),
  setPortalToken: vi.fn(),
}));
import { portalApiFetch } from "@/lib/portal-api";
import { setPortalToken } from "@/lib/auth";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/change-password"]}>
        <ChangePasswordPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChangePasswordPage", () => {
  beforeEach(() => {
    vi.mocked(portalApiFetch).mockReset();
    vi.mocked(setPortalToken).mockReset();
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
    vi.mocked(portalApiFetch).mockResolvedValueOnce({ ok: true, message: "ok" } as never);
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
    vi.mocked(portalApiFetch).mockResolvedValueOnce({ ok: true, message: "ok" } as never);
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-temp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "long-password-1234");
    await userEvent.type(screen.getByLabelText(/confirm/i), "long-password-1234");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    await waitFor(() =>
      expect(portalApiFetch).toHaveBeenCalledWith(
        "/auth/change-password",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("stores the rotated session token so the bearer fallback keeps working", async () => {
    // iOS Safari drops the cross-site portal cookie and authenticates off the
    // stored bearer token instead. The server rotates the session on a password
    // change, so a client that keeps the OLD token would sail on with a session
    // minted under the temporary password.
    vi.mocked(portalApiFetch).mockResolvedValueOnce({
      ok: true,
      message: "ok",
      token: "rotated-token",
    } as never);
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-temp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "long-password-1234");
    await userEvent.type(screen.getByLabelText(/confirm/i), "long-password-1234");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    await waitFor(() => expect(setPortalToken).toHaveBeenCalledWith("rotated-token"));
  });

  it("does not clobber the stored token when the server returns none", async () => {
    // No token means the account lost its partyId; the existing cookie is still
    // valid, so overwriting the stored token with undefined would log the user
    // out on the very next request.
    vi.mocked(portalApiFetch).mockResolvedValueOnce({ ok: true, message: "ok" } as never);
    renderPage();
    await userEvent.type(screen.getByLabelText(/current password/i), "old-temp");
    await userEvent.type(screen.getByLabelText(/^new password/i), "long-password-1234");
    await userEvent.type(screen.getByLabelText(/confirm/i), "long-password-1234");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    await waitFor(() =>
      expect(portalApiFetch).toHaveBeenCalledWith(
        "/auth/change-password",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(setPortalToken).not.toHaveBeenCalled();
  });
});
