import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { VoidReasonDialog } from "../void-reason-dialog";

describe("VoidReasonDialog", () => {
  it("requires a reason (min 3 chars) before confirm enables, then passes it up", () => {
    const onConfirm = vi.fn();
    render(
      <VoidReasonDialog
        open
        title="Void this statement?"
        body="Tan Sri Lim — June 2026 · RM 2,316.00. A Credit Note will be issued."
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole("button", { name: /void & issue credit note/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "ab" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "wrong figures" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("wrong figures");
  });

  it("keeps the typed reason and an enabled Confirm when onConfirm does not close the dialog (e.g. a failed void)", () => {
    // Mirrors billing-pane's void dialog: onConfirm calls a mutation whose
    // onError handler does NOT close the dialog, so the admin can retry
    // without retyping the reason.
    const onConfirm = vi.fn();
    render(
      <VoidReasonDialog
        open
        title="Void this utility bill?"
        body="Every charge this bill posted is reversed."
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole("button", { name: /void & issue credit note/i });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "wrong figures" } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("wrong figures");
    // Dialog stayed open (parent didn't flip `open` to false on error) —
    // the reason must still be there and Confirm still enabled for retry.
    expect(screen.getByLabelText(/reason/i)).toHaveValue("wrong figures");
    expect(confirm).not.toBeDisabled();
  });

  it("resets the reason when the dialog is dismissed via Cancel", () => {
    const onCancel = vi.fn();
    render(
      <VoidReasonDialog
        open
        title="Void this statement?"
        body="Body copy."
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "wrong figures" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(screen.getByLabelText(/reason/i)).toHaveValue("");
  });

  it("resets the reason when the parent closes the dialog after a successful onConfirm (true close, not via Cancel/dismiss)", () => {
    // The dialog is parent-controlled and stays mounted between opens.
    // Confirm itself no longer clears the reason (see the failed-void test
    // above), so this exercises the open:true→false render-time reset path
    // directly — mirroring billing-pane's onConfirm onSuccess handler,
    // which calls setVoidOpen(false) rather than going through Cancel.
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <VoidReasonDialog
            open={open}
            title="Void this statement?"
            body="Body copy."
            onCancel={vi.fn()}
            onConfirm={() => setOpen(false)}
          />
          <button onClick={() => setOpen(true)}>reopen</button>
        </>
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "wrong figures" } });
    fireEvent.click(screen.getByRole("button", { name: /void & issue credit note/i }));
    fireEvent.click(screen.getByRole("button", { name: /reopen/i }));
    expect(screen.getByLabelText(/reason/i)).toHaveValue("");
  });
});
