import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthContext, type AuthContextType, type User } from "@/lib/auth";
import { RoleGate } from "../role-gate";

function makeAuth(user: User | null): AuthContextType {
  return {
    user,
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
    isAuthenticated: !!user,
  };
}

function makeUser(role: string, userType = "operator"): User {
  return { id: "1", fullName: "Test", email: "t@t.com", role, orgId: "o1", userType };
}

function renderGate(role: string | null, min: "admin" | "manager" | "editor") {
  const auth = makeAuth(role ? makeUser(role) : null);
  return render(
    <AuthContext.Provider value={auth}>
      <RoleGate min={min}>
        <div>Gated Content</div>
      </RoleGate>
    </AuthContext.Provider>,
  );
}

describe("RoleGate", () => {
  it("renders children when role meets minimum (manager >= manager)", () => {
    renderGate("manager", "manager");
    expect(screen.getByText("Gated Content")).toBeInTheDocument();
  });

  it("renders children when role exceeds minimum (admin >= manager)", () => {
    renderGate("admin", "manager");
    expect(screen.getByText("Gated Content")).toBeInTheDocument();
  });

  it("hides children when role is below minimum (editor < manager)", () => {
    renderGate("editor", "manager");
    expect(screen.queryByText("Gated Content")).not.toBeInTheDocument();
  });

  it("hides children when role is below minimum (manager < admin)", () => {
    renderGate("manager", "admin");
    expect(screen.queryByText("Gated Content")).not.toBeInTheDocument();
  });

  it("hides children when user is missing", () => {
    renderGate(null, "manager");
    expect(screen.queryByText("Gated Content")).not.toBeInTheDocument();
  });

  it("hides children when role is unrecognised (e.g. portal 'user')", () => {
    renderGate("user", "manager");
    expect(screen.queryByText("Gated Content")).not.toBeInTheDocument();
  });

  it("renders fallback when provided and role is below minimum", () => {
    const auth = makeAuth(makeUser("editor"));
    render(
      <AuthContext.Provider value={auth}>
        <RoleGate min="manager" fallback={<div>Read only</div>}>
          <div>Gated Content</div>
        </RoleGate>
      </AuthContext.Provider>,
    );
    expect(screen.queryByText("Gated Content")).not.toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("editor can see editor-min gates", () => {
    renderGate("editor", "editor");
    expect(screen.getByText("Gated Content")).toBeInTheDocument();
  });
});
