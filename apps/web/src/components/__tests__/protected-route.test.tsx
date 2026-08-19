import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthContext, type AuthContextType } from "@/lib/auth";

// Mock react-router-dom to avoid ESM issues in test environment
const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  Navigate: (props: { to: string; replace?: boolean }) => {
    mockNavigate(props);
    return <div data-testid="navigate" data-to={props.to} />;
  },
  useLocation: () => ({ pathname: "/dashboard" }),
}));

// Import after mocks are set up
import { ProtectedRoute } from "../protected-route";

const baseAuth: AuthContextType = {
  user: null,
  setAuth: vi.fn(),
  clearAuth: vi.fn(),
  isAuthenticated: false,
};

function renderWithAuth(ui: React.ReactNode, authValue: AuthContextType) {
  return render(
    <AuthContext.Provider value={authValue}>{ui}</AuthContext.Provider>,
  );
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it("renders children when authenticated as operator", () => {
    renderWithAuth(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      {
        ...baseAuth,
        isAuthenticated: true,
        user: { id: "1", fullName: "Test", email: "t@t.com", role: "admin", orgId: "o1", userType: "operator" },
      },
    );

    expect(screen.getByText("Protected Content")).toBeInTheDocument();
  });

  it("redirects to /login when not authenticated", () => {
    renderWithAuth(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      baseAuth,
    );

    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    const nav = screen.getByTestId("navigate");
    expect(nav.getAttribute("data-to")).toBe("/login");
  });

  it("redirects tenant users to /portal/login", () => {
    renderWithAuth(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      {
        ...baseAuth,
        isAuthenticated: true,
        user: { id: "1", fullName: "Tenant", email: "t@t.com", role: "user", orgId: "o1", userType: "tenant" },
      },
    );

    expect(screen.queryByText("Protected Content")).not.toBeInTheDocument();
    const nav = screen.getByTestId("navigate");
    expect(nav.getAttribute("data-to")).toBe("/portal/login");
  });
});
