import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SprintRow } from "@/api/tasks";
import { SprintSelector } from "../sprint-selector";

function makeSprint(over: Partial<SprintRow>): SprintRow {
  return {
    id: "s-x",
    seq: 1,
    name: null,
    goal: null,
    status: "planned",
    startsOn: null,
    endsOn: null,
    startedAt: null,
    completedAt: null,
    summary: { committed: 0, completed: 0, carried: 0, completionPct: 0 },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  };
}

const active = makeSprint({ id: "s-active", seq: 4, status: "active" });
const planned = makeSprint({ id: "s-plan", seq: 5, status: "planned", name: "Polish" });
const done = makeSprint({ id: "s-done", seq: 3, status: "completed" });

describe("SprintSelector", () => {
  // ── Legacy contract tests (MUST continue passing) ──────────────────────────

  it("renders Backlog first; active sprint has testid+data-status; clicking emits onSelect", () => {
    const onSelect = vi.fn();
    render(
      <SprintSelector sprints={[done, active, planned]} selected="backlog" onSelect={onSelect} />,
    );

    expect(screen.getByTestId("sprint-selector")).toBeInTheDocument();
    expect(screen.getByTestId("sprint-tab-backlog")).toHaveTextContent("Backlog");
    expect(screen.getByTestId("sprint-tab-backlog")).toHaveAttribute("data-status", "backlog");

    // Active sprint is rendered as a persistent button (not inside the dropdown).
    expect(screen.getByTestId("sprint-tab-s-active")).toHaveTextContent("SP-4");
    expect(screen.getByTestId("sprint-tab-s-active")).toHaveAttribute("data-status", "active");

    // Clicking Backlog and active both emit onSelect.
    fireEvent.click(screen.getByTestId("sprint-tab-s-active"));
    expect(onSelect).toHaveBeenCalledWith("s-active");
    fireEvent.click(screen.getByTestId("sprint-tab-backlog"));
    expect(onSelect).toHaveBeenCalledWith("backlog");
  });

  it("marks the selected tab aria-selected and shows the manage slot", () => {
    render(
      <SprintSelector
        sprints={[active]}
        selected="s-active"
        onSelect={vi.fn()}
        manageMenu={<button>Manage</button>}
      />,
    );
    expect(screen.getByTestId("sprint-tab-s-active")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("sprint-tab-backlog")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  });

  // ── New picker tests ───────────────────────────────────────────────────────

  it("with 100 completed sprints, renders NO per-sprint tab buttons beyond Backlog + active + Sprint trigger", () => {
    const completedSprints = Array.from({ length: 100 }, (_, i) =>
      makeSprint({ id: `s-done-${i}`, seq: i + 1, status: "completed" }),
    );
    render(
      <SprintSelector
        sprints={[active, ...completedSprints]}
        selected="backlog"
        onSelect={vi.fn()}
      />,
    );

    // Only 3 top-level sprint controls must be present:
    //   1. Backlog button
    //   2. active sprint button
    //   3. Sprint ▾ trigger (which contains all planned + completed inside the dropdown)
    expect(screen.getByTestId("sprint-tab-backlog")).toBeInTheDocument();
    expect(screen.getByTestId("sprint-tab-s-active")).toBeInTheDocument();
    expect(screen.getByTestId("sprint-picker-trigger")).toBeInTheDocument();

    // None of the 100 completed sprint buttons must be rendered outside the dropdown.
    completedSprints.forEach((s) => {
      expect(screen.queryByTestId(`sprint-tab-${s.id}`)).toBeNull();
    });
  });

  it("Sprint ▾ dropdown groups by Planned / Completed only (active is NOT in the dropdown)", () => {
    render(
      <SprintSelector
        sprints={[done, active, planned]}
        selected="backlog"
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("sprint-picker-trigger"));

    // The active sprint's canonical home is the persistent pill — it must NOT
    // appear inside the dropdown, so there is one selection path per sprint.
    expect(screen.queryByTestId("sprint-group-active")).toBeNull();
    expect(screen.queryByTestId("sprint-picker-item-s-active")).toBeNull();

    expect(screen.getByTestId("sprint-group-planned")).toBeInTheDocument();
    expect(screen.getByTestId("sprint-group-completed")).toBeInTheDocument();
  });

  it("clicking a completed sprint in the dropdown calls onSelect(id) and relabels the trigger", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <SprintSelector
        sprints={[done, active, planned]}
        selected="backlog"
        onSelect={onSelect}
      />,
    );

    // Open the dropdown.
    fireEvent.click(screen.getByTestId("sprint-picker-trigger"));

    // Click the completed sprint item inside the dropdown.
    const item = screen.getByTestId("sprint-picker-item-s-done");
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith("s-done");

    // Re-render with the completed sprint now selected (as the board page would do).
    rerender(
      <SprintSelector
        sprints={[done, active, planned]}
        selected="s-done"
        onSelect={onSelect}
      />,
    );

    // Trigger now shows the sprint's label, not just "Sprint".
    const trigger = screen.getByTestId("sprint-picker-trigger");
    expect(trigger).toHaveTextContent("SP-3");
  });

  it("clicking a planned sprint in the dropdown calls onSelect(id) and relabels the trigger", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <SprintSelector
        sprints={[done, active, planned]}
        selected="backlog"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId("sprint-picker-trigger"));
    fireEvent.click(screen.getByTestId("sprint-picker-item-s-plan"));
    expect(onSelect).toHaveBeenCalledWith("s-plan");

    rerender(
      <SprintSelector
        sprints={[done, active, planned]}
        selected="s-plan"
        onSelect={onSelect}
      />,
    );

    // Trigger shows the named planned sprint ("SP-5 · Polish").
    const trigger = screen.getByTestId("sprint-picker-trigger");
    expect(trigger).toHaveTextContent("SP-5 · Polish");
  });

  it("clicking Backlog calls onSelect('backlog')", () => {
    const onSelect = vi.fn();
    render(
      <SprintSelector sprints={[active]} selected="s-active" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId("sprint-tab-backlog"));
    expect(onSelect).toHaveBeenCalledWith("backlog");
  });

  it("the active sprint is reachable as the persistent pill, never inside the dropdown", () => {
    const onSelect = vi.fn();
    render(
      <SprintSelector sprints={[done, active, planned]} selected="backlog" onSelect={onSelect} />,
    );

    // Persistent pill exists and selects the active sprint directly.
    fireEvent.click(screen.getByTestId("sprint-tab-s-active"));
    expect(onSelect).toHaveBeenCalledWith("s-active");

    // Opening the dropdown never surfaces the active sprint as an item.
    fireEvent.click(screen.getByTestId("sprint-picker-trigger"));
    expect(screen.queryByTestId("sprint-picker-item-s-active")).toBeNull();
    expect(screen.queryByTestId("sprint-group-active")).toBeNull();
  });

  // #6 — the picker was cramped: min-w-48 (a MIN-width) never overrides Base
  // UI's w-(--anchor-width) tie to the small "Sprint ▾" trigger baked into the
  // shared DropdownMenuContent. A real width utility (w-72) is in the same
  // Tailwind group as w-(--anchor-width), so twMerge fully replaces it.
  // JSDOM doesn't compute real pixel widths, so assert on the className —
  // the pragmatic, robust seam — rather than a layout measurement.
  it("Sprint ▾ dropdown uses fixed width (w-72), not a bare min-w-48 tied to the trigger", () => {
    render(
      <SprintSelector sprints={[done, active, planned]} selected="backlog" onSelect={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("sprint-picker-trigger"));

    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toMatch(/(^|\s)w-72(\s|$)/);
    expect(content!.className).not.toMatch(/(^|\s)min-w-48(\s|$)/);
  });
});
