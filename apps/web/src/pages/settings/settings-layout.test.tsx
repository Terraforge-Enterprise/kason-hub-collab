import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mock @/lib/auth before importing the component under test.
vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(),
  getStoredUser: vi.fn(() => null),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { useAuth } from "@/lib/auth";
import SettingsLayout from "./settings-layout";

const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

function renderAt(path: string, role: string) {
  mockUseAuth.mockReturnValue({
    user: { id: "u1", fullName: "Test User", role, email: "test@example.com", orgId: "org1" },
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
    isAuthenticated: true,
  });

  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="commission" element={<div>Commission content</div>} />
          <Route path="inventory" element={<div>Inventory content</div>} />
          <Route path="sales-renovation" element={<div>Sales Renovation content</div>} />
          <Route path="document-templates" element={<div>Document Templates content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("SettingsLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows manager-level items for a manager user", () => {
    renderAt("/settings/commission", "manager");
    expect(screen.getByRole("link", { name: "Commission & TA" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inventory" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sales & Renovation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Document Templates" })).not.toBeInTheDocument();
  });

  it("shows all items for an admin user", () => {
    renderAt("/settings/commission", "admin");
    expect(screen.getByRole("link", { name: "Commission & TA" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inventory" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales & Renovation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Document Templates" })).toBeInTheDocument();
  });

  it("marks the current section as active", () => {
    renderAt("/settings/inventory", "admin");
    const inventory = screen.getByRole("link", { name: "Inventory" });
    expect(inventory).toHaveAttribute("aria-current", "page");
    const commission = screen.getByRole("link", { name: "Commission & TA" });
    expect(commission).not.toHaveAttribute("aria-current", "page");
  });

  it("renders the child route via Outlet", () => {
    renderAt("/settings/commission", "manager");
    expect(screen.getByText("Commission content")).toBeInTheDocument();
  });

  it("redirects to /dashboard when role has no allowed sections", () => {
    renderAt("/settings/commission", "editor");
    // SettingsLayout redirected to /dashboard; no settings nav rendered
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
  });

  it("redirects bare /settings to the first allowed section", () => {
    renderAt("/settings", "admin");
    // Should redirect to /settings/commission → commission child route renders
    expect(screen.getByText("Commission content")).toBeInTheDocument();
  });
});
