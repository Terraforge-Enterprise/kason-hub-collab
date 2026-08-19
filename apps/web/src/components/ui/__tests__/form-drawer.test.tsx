import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormDrawer } from "../form-drawer";

function setup(overrides: Partial<React.ComponentProps<typeof FormDrawer>> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <FormDrawer
      open
      onClose={onClose}
      title="New thing"
      description="Make a thing"
      onSubmit={onSubmit}
      submit={{ label: "Save", variant: "gold" }}
      {...overrides}
    >
      <div data-testid="body">body</div>
    </FormDrawer>,
  );
  return { onSubmit, onClose };
}

describe("FormDrawer", () => {
  it("renders title, description, body, sticky footer", () => {
    setup();
    expect(screen.getByText("New thing")).toBeInTheDocument();
    expect(screen.getByText("Make a thing")).toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders the warning Callout when warning prop is provided", () => {
    setup({ warning: { variant: "warning", title: "Heads up", body: "You sure?" } });
    expect(screen.getByText(/Heads up/)).toBeInTheDocument();
    expect(screen.getByText(/You sure\?/)).toBeInTheDocument();
  });

  it("calls onSubmit when the submit button is clicked", async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the Cancel button is clicked", async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button when submit.disabled=true", () => {
    setup({ submit: { label: "Save", variant: "gold", disabled: true } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows pendingLabel and disables submit while pending", () => {
    setup({ submit: { label: "Save", pendingLabel: "Saving…", variant: "gold", pending: true } });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("opens the AlertDialog when a primary submit with confirm is clicked, and only fires onSubmit after confirm", async () => {
    const onSubmit = vi.fn();
    render(
      <FormDrawer
        open onClose={() => {}}
        title="t" onSubmit={onSubmit}
        submit={{
          label: "Submit", variant: "gold",
          confirm: { title: "Sure?", body: "Final answer.", confirmLabel: "Yes" },
        }}
      >body</FormDrawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Sure?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("filters falsy entries from secondaryActions", () => {
    setup({
      secondaryActions: [
        false,
        null,
        undefined,
        { label: "Withdraw", variant: "ghost", onClick: () => {} },
      ],
    });
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("secondary action confirm runs only its own onClick, not onSubmit", async () => {
    const onSubmit = vi.fn();
    const onWithdraw = vi.fn();
    render(
      <FormDrawer
        open onClose={() => {}}
        title="t" onSubmit={onSubmit}
        submit={{ label: "Save", variant: "gold" }}
        secondaryActions={[
          {
            label: "Withdraw",
            variant: "ghost",
            onClick: onWithdraw,
            confirm: { title: "Withdraw?", body: "Sure?", confirmLabel: "Yes", destructive: true },
          },
        ]}
      >body</FormDrawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter inside the form fires onSubmit when no confirm is set", async () => {
    const onSubmit = vi.fn();
    render(
      <FormDrawer
        open onClose={() => {}}
        title="t" onSubmit={onSubmit}
        submit={{ label: "Save", variant: "gold" }}
      >
        <input data-testid="field" />
      </FormDrawer>,
    );
    screen.getByTestId("field").focus();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Enter inside the form opens the AlertDialog instead of firing onSubmit when confirm is set", async () => {
    const onSubmit = vi.fn();
    render(
      <FormDrawer
        open onClose={() => {}}
        title="t" onSubmit={onSubmit}
        submit={{
          label: "Submit", variant: "gold",
          confirm: { title: "Sure?", body: "Final answer.", confirmLabel: "Yes" },
        }}
      >
        <input data-testid="field" />
      </FormDrawer>,
    );
    screen.getByTestId("field").focus();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Sure?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("primary submit with onClick uses the onClick handler instead of onSubmit", async () => {
    const onSubmit = vi.fn();
    const onClick = vi.fn();
    render(
      <FormDrawer
        open onClose={() => {}}
        title="t" onSubmit={onSubmit}
        submit={{ label: "Save", variant: "gold", onClick }}
      >body</FormDrawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("omits the primary submit button when submit prop is undefined", () => {
    render(
      <FormDrawer open onClose={() => {}} title="View" onSubmit={() => {}}>
        <div>body</div>
      </FormDrawer>,
    );
    expect(screen.queryByRole("button", { name: /Save/i })).toBeNull();
    // Cancel is still present.
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
  });
});
