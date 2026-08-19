import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PendingDiffDrawer } from "../pending-diff-drawer";

describe("<PendingDiffDrawer>", () => {
  const current = { rentalRate: 1000, depositMonths: 2, unitCode: "A-1" };
  const pendingChanges = { rentalRate: 1500, depositMonths: 3 };

  it("renders only the fields that changed", () => {
    render(
      <PendingDiffDrawer
        open
        onOpenChange={() => {}}
        current={current}
        pendingChanges={pendingChanges}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByText("rentalRate")).toBeInTheDocument();
    expect(screen.getByText("depositMonths")).toBeInTheDocument();
    expect(screen.queryByText("unitCode")).not.toBeInTheDocument();
  });

  it("shows old → new for each diffed field", () => {
    render(
      <PendingDiffDrawer
        open
        onOpenChange={() => {}}
        current={current}
        pendingChanges={pendingChanges}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByText("1000")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });

  it("fires onApprove and onReject", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <PendingDiffDrawer
        open
        onOpenChange={() => {}}
        current={current}
        pendingChanges={pendingChanges}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onReject).toHaveBeenCalled();
  });
});
