import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TncModal } from "../tnc-modal";

describe("TncModal — scroll-to-bottom gate", () => {
  it("footer button is disabled and labelled 'Scroll to bottom to continue' on initial open", () => {
    render(
      <TncModal
        open={true}
        onClose={() => {}}
        onReadToBottom={() => {}}
        customTerms={[]}
      />,
    );
    const btn = screen.getByRole("button", { name: /scroll to bottom to continue/i });
    expect(btn).toBeDisabled();
  });

  it("fires onReadToBottom and enables the close button once the scrollable region is scrolled to bottom", () => {
    const onReadToBottom = vi.fn();
    render(
      <TncModal
        open={true}
        onClose={() => {}}
        onReadToBottom={onReadToBottom}
        customTerms={[]}
      />,
    );
    // The scrollable region is the only div with onScroll — find it by traversing
    // the rendered DOM. It contains the ordered list of clauses.
    const ol = screen.getByRole("list");
    const scrollable = ol.parentElement!;
    // Simulate measured-DOM scroll-to-bottom (jsdom returns 0 for measurements
    // by default; stub them on the element).
    Object.defineProperty(scrollable, "scrollTop", { value: 1000, configurable: true });
    Object.defineProperty(scrollable, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(scrollable, "scrollHeight", { value: 1000, configurable: true });
    fireEvent.scroll(scrollable);
    expect(onReadToBottom).toHaveBeenCalledTimes(1);
    // The footer button is now enabled. There are two "Close" buttons (X icon + footer),
    // so assert none of the close buttons are disabled after scrolling.
    const closeButtons = screen.getAllByRole("button", { name: /^close$/i });
    // At least one should exist; the footer button (last) should not be disabled.
    expect(closeButtons.at(-1)).not.toBeDisabled();
  });

  it("respects initialReachedBottom so a reopened modal starts in the enabled state", () => {
    render(
      <TncModal
        open={true}
        onClose={() => {}}
        onReadToBottom={() => {}}
        customTerms={[]}
        initialReachedBottom={true}
      />,
    );
    // Footer button is the last button with name "Close"; should not be disabled.
    const closeButtons = screen.getAllByRole("button", { name: /^close$/i });
    expect(closeButtons.at(-1)).not.toBeDisabled();
  });

  it("renders the customTerms list verbatim when non-empty (defaults are NOT shown)", () => {
    render(
      <TncModal
        open={true}
        onClose={() => {}}
        onReadToBottom={() => {}}
        customTerms={["First clause.", "Second clause."]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("First clause.");
    expect(items[1].textContent).toContain("Second clause.");
  });
});
