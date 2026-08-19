import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ListingMediaPanel } from "../listing-media-panel";

// This suite uses the REAL RoleGate (unlike listing-media-panel.test.tsx,
// which stubs it) so we actually exercise the min="editor" gate on the tile
// Remove button. useAuth is mocked so we can drive the current role.
const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, useAuth: useAuthMock };
});

// Never-resolving apiFetch: tiles render empty (no signed URLs) but the tile
// + its Remove button still render — the button is gated only by RoleGate.
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const LISTING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PHOTO = `units/${LISTING}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg`;

function renderPanel() {
  return render(
    withQuery(
      <ListingMediaPanel
        listingId={LISTING}
        photoKeys={[PHOTO]}
        videoKeys={[]}
        onPhotoKeysChange={() => {}}
        onVideoKeysChange={() => {}}
      />,
    ),
  );
}

describe("ListingMediaPanel — Remove button RBAC (real RoleGate)", () => {
  beforeEach(() => useAuthMock.mockReset());

  it.each(["editor", "manager", "admin"])(
    "shows the tile Remove button for %s",
    (role) => {
      useAuthMock.mockReturnValue({ user: { role } });
      renderPanel();
      // aria-label="Remove" is the tile button; the confirm dialog's Remove
      // button (text only, no aria-label) is not mounted until the dialog opens.
      expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    },
  );

  it("hides the Remove button when the user has no recognised admin role", () => {
    useAuthMock.mockReturnValue({ user: null });
    renderPanel();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("hides the Remove button for a below-editor role (e.g. viewer)", () => {
    useAuthMock.mockReturnValue({ user: { role: "viewer" } });
    renderPanel();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
