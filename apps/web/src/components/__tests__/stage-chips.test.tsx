import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageChips } from "../stage-chips";

describe("StageChips", () => {
  it("renders one chip per stage", () => {
    render(<StageChips stages={[
      { stageKey: "demo", stageLabel: "Demolition", status: "completed" },
      { stageKey: "wiring", stageLabel: "Wiring", status: "in_progress" },
      { stageKey: "tiling", stageLabel: "Tiling", status: "pending" },
    ]} />);
    expect(screen.getByText("Demolition")).toBeInTheDocument();
    expect(screen.getByText("Wiring")).toBeInTheDocument();
    expect(screen.getByText("Tiling")).toBeInTheDocument();
  });

  it("applies data-status attributes per chip", () => {
    const { container } = render(<StageChips stages={[
      { stageKey: "a", stageLabel: "A", status: "completed" },
      { stageKey: "b", stageLabel: "B", status: "in_progress" },
      { stageKey: "c", stageLabel: "C", status: "pending" },
    ]} />);
    expect(container.querySelector("[data-status='completed']")).toBeTruthy();
    expect(container.querySelector("[data-status='in_progress']")).toBeTruthy();
    expect(container.querySelector("[data-status='pending']")).toBeTruthy();
  });
});
