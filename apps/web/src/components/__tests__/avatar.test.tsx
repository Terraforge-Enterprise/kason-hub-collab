import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar } from "../avatar";

describe("Avatar", () => {
  it("renders an img when src is provided", () => {
    render(<Avatar src="https://example/x.jpg" name="Jane Doe" size="md" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://example/x.jpg");
    expect(img).toHaveAttribute("alt", "Jane Doe");
  });

  it("renders initials fallback when src is null", () => {
    render(<Avatar src={null} name="Jane Doe" size="md" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("JD")).toBeInTheDocument();
  });

  it("renders single initial for single-word names", () => {
    render(<Avatar src={null} name="Cher" size="sm" />);
    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("renders a question mark when name is empty", () => {
    render(<Avatar src={null} name="" size="sm" />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});
