import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PortalResetPasswordPage from "../reset-password-page";

describe("PortalResetPasswordPage", () => {
  it("renders the invalid state when no ?token= is present", () => {
    render(
      <MemoryRouter initialEntries={["/portal/reset-password"]}>
        <PortalResetPasswordPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/invalid or expired/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /request a new link/i })).toHaveAttribute("href", "/portal/forgot-password");
  });
});
