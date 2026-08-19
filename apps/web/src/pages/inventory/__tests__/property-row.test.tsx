import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PropertyRow, type PropertyListItem } from "../property-row";
import type { UnitListItem } from "../units-table";
import type { PropertyOption } from "../create-unit-dialog";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// vi.mock is hoisted above top-level statements, so factory bodies can't
// reference module-level vars. Use vi.hoisted() to lift the spy refs alongside.
const { apiFetchMock, portalApiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(() => new Promise(() => {})),
  portalApiFetchMock: vi.fn(() => new Promise(() => {})),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: apiFetchMock,
}));

vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: portalApiFetchMock,
  PortalApiError: class PortalApiError extends Error {},
}));

function fixtureProperty(): PropertyListItem {
  return {
    id: "p1",
    name: "The Sky Residences",
    propertyCode: "SKY",
    propertyType: "condominium",
    status: "active",
    unitCount: 3,
    occupiedUnits: 1,
  };
}

function propertyOptions(): PropertyOption[] {
  return [{ id: "p1", name: "The Sky Residences", propertyCode: "SKY" }];
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("property-row keyboard interaction", () => {
  it("does not collapse/expand the row when Space is pressed inside a child input", () => {
    // Render the row WITH a child input directly inside it. The bug being
    // fixed: row's onKeyDown calls e.preventDefault() on Space without
    // filtering by target, swallowing keystrokes inside dialog form fields
    // that bubble synthetic events through the React tree even when the
    // DOM target lives in a portal.
    const units: UnitListItem[] = [];

    const { container } = render(
      wrap(
        <PropertyRow
          property={fixtureProperty()}
          units={units}
          propertyOptions={propertyOptions()}
        />,
      ),
    );

    // The row's clickable wrapper carries role="button". Sanity-check it
    // exists and is collapsed.
    // The row clickable wrapper is a <div role="button"> — distinguish it
    // from the inline action <button> elements (which carry
    // aria-haspopup="dialog") by selecting on the DOM directly.
    const rowButton = document.querySelector(
      'div[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(rowButton.getAttribute("aria-expanded")).toBe("false");

    // Synthesise an input inside the row (simulating a child Dialog form's
    // input that has bubbled its keydown synthetic event up the React tree).
    // We append a real <input> child and fire a keydown space event from it,
    // and assert the row's expanded state did NOT toggle.
    const fakeInput = document.createElement("input");
    fakeInput.type = "text";
    rowButton.appendChild(fakeInput);
    fakeInput.focus();

    fireEvent.keyDown(fakeInput, { key: " ", code: "Space" });

    // If the bug were live, the row's onKeyDown would have flipped
    // aria-expanded to "true" because preventDefault → setExpanded fires.
    // After the fix, the guard returns early when the target is an input.
    expect(rowButton.getAttribute("aria-expanded")).toBe("false");

    // Also assert the row container element itself didn't get a stale ref
    // (defensive against future regressions where the row remounts).
    expect(container).toBeTruthy();
  });

  it("never calls portalApiFetch on mount (admin envelope only)", () => {
    apiFetchMock.mockClear();
    portalApiFetchMock.mockClear();
    render(
      wrap(
        <PropertyRow
          property={fixtureProperty()}
          units={[]}
          propertyOptions={propertyOptions()}
        />,
      ),
    );
    // The top-level CreateRoomsMultiDialog was removed (Fix-8a). The
    // per-apartment CreateRoomsMultiDialog only renders after the row is
    // expanded and apartments are fetched, so nothing should fire on mount.
    // Guard: portalApiFetch must never be called — an admin user without a
    // portal cookie would get a 401 hard-redirect to /portal/login.
    expect(portalApiFetchMock).not.toHaveBeenCalled();
    // apiFetch is also not expected on mount now that the top-level
    // CreateRoomsMultiDialog (which pre-fetched room types) is gone.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("still toggles when Space is pressed on the row itself (non-input target)", () => {
    render(
      wrap(
        <PropertyRow
          property={fixtureProperty()}
          units={[]}
          propertyOptions={propertyOptions()}
        />,
      ),
    );

    // The row clickable wrapper is a <div role="button"> — distinguish it
    // from the inline action <button> elements (which carry
    // aria-haspopup="dialog") by selecting on the DOM directly.
    const rowButton = document.querySelector(
      'div[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(rowButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(rowButton, { key: " ", code: "Space" });
    expect(rowButton.getAttribute("aria-expanded")).toBe("true");
  });
});
