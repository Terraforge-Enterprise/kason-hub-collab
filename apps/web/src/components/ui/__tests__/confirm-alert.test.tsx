import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmAlert } from "../confirm-alert";

describe("ConfirmAlert", () => {
  it("renders title, body, confirm and cancel buttons when open", () => {
    render(
      <ConfirmAlert
        open
        onCancel={() => {}}
        onConfirm={() => {}}
        title="Withdraw this claim?"
        body="It will be terminated."
        confirmLabel="Withdraw"
      />,
    );
    expect(screen.getByText("Withdraw this claim?")).toBeInTheDocument();
    expect(screen.getByText("It will be terminated.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmAlert open onCancel={() => {}} onConfirm={onConfirm}
        title="t" body="b" confirmLabel="Yes" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmAlert open onCancel={onCancel} onConfirm={() => {}}
        title="t" body="b" confirmLabel="Yes" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses destructive button variant when destructive=true", () => {
    render(
      <ConfirmAlert open onCancel={() => {}} onConfirm={() => {}}
        title="t" body="b" confirmLabel="Delete" destructive />,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toMatch(/destructive|bg-destructive|text-destructive-foreground/);
  });

  it("renders nothing when open=false", () => {
    render(
      <ConfirmAlert open={false} onCancel={() => {}} onConfirm={() => {}}
        title="hidden" body="b" confirmLabel="Yes" />,
    );
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });

  it("fires onConfirm exactly once and onCancel zero times when confirm is clicked", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmAlert open onCancel={onCancel} onConfirm={onConfirm}
        title="t" body="b" confirmLabel="Yes" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("fires onCancel exactly once and onConfirm zero times when cancel is clicked", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmAlert open onCancel={onCancel} onConfirm={onConfirm}
        title="t" body="b" confirmLabel="Yes" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("fires onCancel when Escape dismisses the dialog", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmAlert open onCancel={onCancel} onConfirm={onConfirm}
        title="t" body="b" confirmLabel="Yes" />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
