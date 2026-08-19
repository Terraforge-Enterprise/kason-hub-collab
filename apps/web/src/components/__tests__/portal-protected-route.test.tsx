import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortalApiError } from "@/lib/portal-api";

const mockUseQuery = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock("react-router-dom", () => ({
  Navigate: (props: { to: string }) => <div data-testid="navigate" data-to={props.to} />,
  useLocation: () => ({ pathname: "/portal/dashboard" }),
}));

import { PortalProtectedRoute } from "../portal-protected-route";

describe("PortalProtectedRoute", () => {
  it("renders children when profile query succeeds", () => {
    mockUseQuery.mockReturnValueOnce({
      data: { data: { userType: "tenant" } },
      isLoading: false,
      error: null,
    });

    render(
      <PortalProtectedRoute>
        <div>Portal Content</div>
      </PortalProtectedRoute>,
    );

    expect(screen.getByText("Portal Content")).toBeInTheDocument();
  });

  it("redirects to login on unauthorized profile fetch", () => {
    mockUseQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new PortalApiError("Session expired", 401),
    });

    render(
      <PortalProtectedRoute>
        <div>Portal Content</div>
      </PortalProtectedRoute>,
    );

    expect(screen.getByTestId("navigate").getAttribute("data-to")).toBe("/portal/login");
  });

  it("shows an error state for transient backend failures", () => {
    mockUseQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new PortalApiError("API error 503", 503),
    });

    render(
      <PortalProtectedRoute>
        <div>Portal Content</div>
      </PortalProtectedRoute>,
    );

    expect(screen.getByText("Portal temporarily unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
  });
});
