import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist so the vi.fn() references are available inside the hoisted vi.mock factory.
const grantMutate = vi.hoisted(() => vi.fn());
const resetMutate = vi.hoisted(() => vi.fn());
const revokeMutate = vi.hoisted(() => vi.fn());

vi.mock("@/components/role-gate", () => ({ RoleGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../use-portal-access-actions", () => ({
  usePortalAccessActions: () => ({
    grant:  { mutate: grantMutate,  isPending: false },
    reset:  { mutate: resetMutate,  isPending: false },
    revoke: { mutate: revokeMutate, isPending: false },
  }),
}));

import { PortalAccessSection } from "../portal-access-section";

const wrap = () => {
  const qc = new QueryClient();
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

/** Returns the submit button (type="submit") among buttons matching `name`. */
function submitBtn(name: RegExp) {
  return screen
    .getAllByRole("button", { name })
    .find((b) => (b as HTMLButtonElement).type === "submit")!;
}

describe("PortalAccessSection", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Rendering smoke tests (kept as-is) ────────────────────────────────────

  it("shows Grant when no portalUser", () => {
    render(<PortalAccessSection partyId="p1" kind="owner" portalUser={null} defaultEmail="o@x.com" defaultFullName="O" />, { wrapper: wrap() });
    expect(screen.getByRole("button", { name: /grant portal access/i })).toBeInTheDocument();
  });

  it("shows email + Reset/Revoke when portalUser exists", () => {
    render(<PortalAccessSection partyId="p1" kind="owner" portalUser={{ email: "o@x.com", status: "active", lastLoginAt: null, updatedAt: "2026-01-01T00:00:00.000Z" }} defaultEmail="o@x.com" defaultFullName="O" />, { wrapper: wrap() });
    expect(screen.getByText("o@x.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument();
  });

  // ── Behavioral tests ──────────────────────────────────────────────────────

  it("grant payload: calls grant.mutate with prefilled email/fullName and typed password", async () => {
    const user = userEvent.setup();
    render(
      <PortalAccessSection partyId="p1" kind="owner" portalUser={null} defaultEmail="o@x.com" defaultFullName="O" />,
      { wrapper: wrap() },
    );

    // Open the Grant drawer (the one visible type="button" trigger).
    await user.click(screen.getByRole("button", { name: /grant portal access/i }));

    // Wait for the drawer to mount and the useEffect to prefill the form.
    await screen.findByPlaceholderText("Minimum 6 characters");

    // The password field (type="password") is not reachable via getByRole("textbox").
    await user.type(screen.getByPlaceholderText("Minimum 6 characters"), "secret1");

    // Click the drawer's submit button (type="submit"), distinct from the trigger (type="button").
    await user.click(submitBtn(/grant portal access/i));

    // Email and fullName come from the prefilled defaults; only password is typed.
    expect(grantMutate.mock.calls[0][0]).toEqual({ email: "o@x.com", password: "secret1", fullName: "O" });
  });

  it("reset payload: calls reset.mutate with typed password", async () => {
    const user = userEvent.setup();
    render(
      <PortalAccessSection
        partyId="p1"
        kind="owner"
        portalUser={{ email: "o@x.com", status: "active", lastLoginAt: null, updatedAt: "2026-01-01T00:00:00.000Z" }}
        defaultEmail="o@x.com"
        defaultFullName="O"
      />,
      { wrapper: wrap() },
    );

    // Open the Reset drawer.
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    // "New temporary password" field is type="text" (per reset-portal-password-drawer pattern).
    await screen.findByPlaceholderText("Minimum 6 characters");
    await user.type(screen.getByPlaceholderText("Minimum 6 characters"), "newpass1");

    // Click the drawer's submit button.
    await user.click(submitBtn(/reset password/i));

    expect(resetMutate.mock.calls[0][0]).toEqual({ password: "newpass1" });
  });

  it("revoke payload: calls revoke.mutate with portalUser.updatedAt after confirm", async () => {
    const user = userEvent.setup();
    render(
      <PortalAccessSection
        partyId="p1"
        kind="owner"
        portalUser={{ email: "o@x.com", status: "active", lastLoginAt: null, updatedAt: "2026-01-01T00:00:00.000Z" }}
        defaultEmail="o@x.com"
        defaultFullName="O"
      />,
      { wrapper: wrap() },
    );

    // Click "Revoke" (exact match avoids matching "Revoke access" in the confirm dialog).
    await user.click(screen.getByRole("button", { name: /^revoke$/i }));

    // ConfirmAlert opens — wait for the confirm button to appear.
    const confirmBtn = await screen.findByRole("button", { name: /revoke access/i });
    await user.click(confirmBtn);

    expect(revokeMutate.mock.calls[0][0]).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z" });
  });
});
