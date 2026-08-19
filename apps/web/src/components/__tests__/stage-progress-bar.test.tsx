import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageProgressBar } from "../stage-progress-bar";

describe("StageProgressBar", () => {
  it("renders 0 of 7 when nothing completed", () => {
    render(<StageProgressBar completed={0} total={7} />);
    expect(screen.getByText(/0 of 7/)).toBeInTheDocument();
    expect(screen.getByText(/0%/)).toBeInTheDocument();
  });

  it("renders 7 of 7 + 100%", () => {
    render(<StageProgressBar completed={7} total={7} />);
    expect(screen.getByText(/7 of 7/)).toBeInTheDocument();
    expect(screen.getByText(/100%/)).toBeInTheDocument();
  });

  it("handles total=0 without crashing (guards against division by zero)", () => {
    render(<StageProgressBar completed={0} total={0} />);
    expect(screen.getByText(/0 of 0/)).toBeInTheDocument();
    expect(screen.getByText(/0%/)).toBeInTheDocument();
  });
});
