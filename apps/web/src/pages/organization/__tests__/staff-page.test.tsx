// StaffPage — the unified operator-user register that replaced the separate
// Managers + Admin pages. Coverage is ported from the retired admins-page /
// managers-page tests, plus the two behaviours new to the merge: the Role
// filter chips, and the "+ Add user" drawer offering Manager (not just
// editor/viewer as the old Admin page did).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(),
  getStoredUser: vi.fn(() => null),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

vi.mock("@/components/role-gate", () => ({
  RoleGate: ({
    min,
    children,
    fallback = null,
  }: {
    min: string;
    children: React.ReactNode;
    fallback?: React.ReactNode;
  }) => {
    const { __testRole } = globalThis as { __testRole?: string };
    const RANK: Record<string, number> = { editor: 1, manager: 2, admin: 3 };
    const role = __testRole ?? "editor";
    const current = RANK[role] ?? 0;
    const required = RANK[min] ?? Number.POSITIVE_INFINITY;
    return current >= required ? <>{children}</> : <>{fallback}</>;
  },
}));

import { useAuth } from "@/lib/auth";
import StaffPage from "../staff-page";

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    // MemoryRouter: StaffPage renders <TeamAreaTabs> which uses <Link>.
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function u(overrides: Record<string, unknown>) {
  return {
    id: "u",
    email: "x@example.com",
    fullName: "X",
    role: "editor",
    status: "active",
    lastLoginAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    mustChangePassword: false,
    photoUrl: null,
    partyId: null,
    party: null,
    ...overrides,
  };
}

const sampleUsers = [
  u({ id: "u1", email: "alice@example.com", fullName: "Alice Manager", role: "manager", status: "active", photoUrl: "https://signed/alice.jpg" }),
  u({ id: "u2", email: "bob@example.com", fullName: "Bob Editor", role: "editor", status: "disabled" }),
  u({ id: "u3", email: "root@example.com", fullName: "Root Admin", role: "admin", status: "active" }),
  u({ id: "u4", email: "vera@example.com", fullName: "Vera Viewer", role: "viewer", status: "active" }),
];

function roleGroup() {
  return within(screen.getByRole("group", { name: /filter by role/i }));
}

describe("StaffPage", () => {
  const originalFetch = globalThis.fetch;
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
    globalThis.fetch = vi.fn();
    (globalThis as { __testRole?: string }).__testRole = "editor";
    mockUseAuth.mockReturnValue({
      user: { id: "current-user", fullName: "Current User", role: "editor", email: "current@example.com", orgId: "org1" },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as { __testRole?: string }).__testRole;
    vi.restoreAllMocks();
  });

  it("fetches the four managed operator roles in one query, excluding accountant", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeResponse({ data: [] }));

    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/users");
    // One query for the whole register (the merge point) — the union of the two
    // retired pages' roles. Crucially it must NOT leak the accountant capability
    // role, which has no filter chip, no ROLE_LABELS entry, and no editable role
    // in the Add/Edit drawer.
    expect(url).toMatch(/roles=/);
    for (const role of ["admin", "manager", "editor", "viewer"]) {
      expect(url).toContain(role);
    }
    expect(url).not.toContain("accountant");
  });

  it("renders empty state when there are no users", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: [] }));
    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(screen.getByText(/no staff users yet/i)).toBeInTheDocument());
  });

  it("renders every operator role in one table, with status pills", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: sampleUsers }));
    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });

    await waitFor(() => expect(screen.getByText("Alice Manager")).toBeInTheDocument());
    expect(screen.getByText("Bob Editor")).toBeInTheDocument();
    expect(screen.getByText("Root Admin")).toBeInTheDocument();
    expect(screen.getByText("Vera Viewer")).toBeInTheDocument();
    // Status pills render (Bob is disabled; the other three active). getAllByText
    // because "Active"/"Disabled" also appear as PageHeader metric labels — this
    // mirrors the assertion the retired admins-page test carried.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
  });

  it("role filter chips narrow the register — 'Manager' reproduces the old Managers view", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: sampleUsers }));
    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(screen.getByText("Alice Manager")).toBeInTheDocument());

    // Click the Manager chip (scoped to the filter group to avoid matching the
    // "Actions for Alice Manager" row button).
    fireEvent.click(roleGroup().getByRole("button", { name: /manager/i }));

    expect(screen.getByText("Alice Manager")).toBeInTheDocument();
    expect(screen.queryByText("Bob Editor")).toBeNull();
    expect(screen.queryByText("Root Admin")).toBeNull();
    expect(screen.queryByText("Vera Viewer")).toBeNull();

    // Switch to Admin → only the admin row.
    fireEvent.click(roleGroup().getByRole("button", { name: /admin/i }));
    expect(screen.getByText("Root Admin")).toBeInTheDocument();
    expect(screen.queryByText("Alice Manager")).toBeNull();
  });

  it("shows + Add user for a manager session, hides it for an editor", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: [] }));

    // Editor: hidden.
    const editor = render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(screen.queryByRole("button", { name: /\+ add user/i })).toBeNull());
    editor.unmount();

    // Manager: shown.
    (globalThis as { __testRole?: string }).__testRole = "manager";
    mockUseAuth.mockReturnValue({
      user: { id: "current-user", fullName: "Current User", role: "manager", email: "current@example.com", orgId: "org1" },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    });
    render(<StaffPage />, { wrapper: makeWrapper(makeQueryClient()) });
    await waitFor(() => expect(screen.getByRole("button", { name: /\+ add user/i })).toBeInTheDocument());
  });

  it("does not render an action menu on admin-tier rows (managed out-of-band)", async () => {
    (globalThis as { __testRole?: string }).__testRole = "manager";
    mockUseAuth.mockReturnValue({
      user: { id: "current-user", fullName: "Current User", role: "manager", email: "current@example.com", orgId: "org1" },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: sampleUsers }));

    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(screen.getByText("Root Admin")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /actions for root admin/i })).toBeNull();
    expect(screen.getByRole("button", { name: /actions for alice manager/i })).toBeInTheDocument();
  });

  it("+ Add user drawer offers Manager as a role (not just editor/viewer)", async () => {
    (globalThis as { __testRole?: string }).__testRole = "manager";
    mockUseAuth.mockReturnValue({
      user: { id: "current-user", fullName: "Current User", role: "manager", email: "current@example.com", orgId: "org1" },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: [] }));

    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => screen.getByRole("button", { name: /\+ add user/i }));
    fireEvent.click(screen.getByRole("button", { name: /\+ add user/i }));

    // The role <select> must include Manager, Editor, and Viewer options.
    await waitFor(() => expect(screen.getByRole("option", { name: "Manager" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Viewer" })).toBeInTheDocument();
  });

  it("marks the self row with '(you)'", async () => {
    mockUseAuth.mockReturnValue({
      user: { id: "u1", fullName: "Alice Manager", role: "manager", email: "alice@example.com", orgId: "org1" },
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      isAuthenticated: true,
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: sampleUsers }));
    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(screen.getByText("(you)")).toBeInTheDocument());
  });

  it("renders an Avatar img for users with photoUrl, initials fallback otherwise", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeResponse({ data: sampleUsers }));
    render(<StaffPage />, { wrapper: makeWrapper(queryClient) });
    await waitFor(() => screen.getByText("Alice Manager"));

    const aliceImg = screen.getByRole("img", { name: "Alice Manager" });
    expect(aliceImg).toHaveAttribute("src", "https://signed/alice.jpg");
    // Bob Editor has null photoUrl → initials "BE".
    expect(screen.getByText("BE")).toBeInTheDocument();
  });
});
