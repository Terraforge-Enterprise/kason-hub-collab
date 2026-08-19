import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock AvatarUploader to keep the test simple — just verify it renders
vi.mock("@/components/avatar-uploader", () => ({
  AvatarUploader: ({ name }: { mode: string; currentPhotoUrl: string | null; name: string }) => (
    <div data-testid="avatar-uploader">{name}</div>
  ),
}));

vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: vi.fn(),
  PortalApiError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

// Mock the hook to return a fixed profile
vi.mock("@/components/portal-protected-route", () => ({
  usePortalProfile: vi.fn(() => ({
    data: {
      data: {
        fullName: "Alice Tan",
        email: "alice@example.com",
        // Canonical form per phoneSchema: 60xxxxxxxxx (no leading +)
        phone: "60123456789",
        partyType: "tenant",
        userType: "portal",
        photoUrl: null,
        photoKey: null,
      },
    },
    isLoading: false,
  })),
}));

import PortalProfilePage from "../profile";
import { portalApiFetch } from "@/lib/portal-api";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/portal/profile"]}>
        <PortalProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PortalProfilePage", () => {
  beforeEach(() => {
    vi.mocked(portalApiFetch).mockReset();
  });

  it("renders AvatarUploader", () => {
    renderPage();
    expect(screen.getByTestId("avatar-uploader")).toBeInTheDocument();
  });

  it("renders 'Edit profile' button in view mode", () => {
    renderPage();
    expect(screen.getByRole("button", { name: /edit profile/i })).toBeInTheDocument();
  });

  it("renders 'Change password' link pointing to /portal/change-password", () => {
    renderPage();
    const link = screen.getByRole("link", { name: /change password/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/portal/change-password");
  });

  it("switches to edit mode and shows name + phone inputs", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /edit profile/i }));
    expect(screen.getByDisplayValue("Alice Tan")).toBeInTheDocument();
    // <PhoneInput> strips the "60" country prefix into a locked-prefix span;
    // the input value is just the national digits.
    expect(screen.getByDisplayValue("123456789")).toBeInTheDocument();
    // Locked +60 prefix is visible alongside.
    expect(screen.getByText("+60")).toBeInTheDocument();
  });

  it("Cancel returns to view mode", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /edit profile/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("button", { name: /edit profile/i })).toBeInTheDocument();
  });

  it("Save calls PATCH /profile/me with updated name and phone", async () => {
    vi.mocked(portalApiFetch).mockResolvedValueOnce({ ok: true } as never);
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /edit profile/i }));

    const nameInput = screen.getByDisplayValue("Alice Tan");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Bob Lim");

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(portalApiFetch).toHaveBeenCalledWith(
        "/profile/me",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const callArg = vi.mocked(portalApiFetch).mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(callArg.body as string);
    expect(body.fullName).toBe("Bob Lim");
  });
});
