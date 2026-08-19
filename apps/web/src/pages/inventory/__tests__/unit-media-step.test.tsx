import { StrictMode } from "react";
import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the real panel so this test asserts the props SingleUnitMediaPanel/
// CreateUnitMediaStep pass — never the panel's upload/limits machinery.
// The mock also exposes two buttons that call the parent's
// onPhotoKeysChange/onVideoKeysChange callbacks directly, standing in for a
// server-confirmed add/delete inside the real ListingMediaPanel — this is
// how the onMediaChanged plumbing tests (Fix C) drive a key change.
const panelProps: Array<{ listingId: string | null; photoKeys: string[]; videoKeys: string[] }> = [];
vi.mock("../listing-media-panel", () => ({
  ListingMediaPanel: (p: {
    listingId: string | null;
    photoKeys: string[];
    videoKeys: string[];
    onPhotoKeysChange: (next: string[]) => void;
    onVideoKeysChange: (next: string[]) => void;
  }) => {
    panelProps.push({ listingId: p.listingId, photoKeys: p.photoKeys, videoKeys: p.videoKeys });
    return (
      <div data-testid="panel" data-listing-id={p.listingId ?? ""}>
        <button onClick={() => p.onPhotoKeysChange(["new-p"])}>set-photo-{p.listingId}</button>
        <button onClick={() => p.onVideoKeysChange(["new-v"])}>set-video-{p.listingId}</button>
      </div>
    );
  },
}));

import { SingleUnitMediaPanel, CreateUnitMediaStep } from "../unit-media-step";

afterEach(() => { cleanup(); panelProps.length = 0; });

describe("SingleUnitMediaPanel", () => {
  it("mounts the panel bound to listingId and seeds initial keys", () => {
    const { getByTestId } = render(
      <SingleUnitMediaPanel listingId="u1" initialPhotoKeys={["p1"]} />,
    );
    expect(getByTestId("panel").getAttribute("data-listing-id")).toBe("u1");
    expect(panelProps).toHaveLength(1);
    expect(panelProps[0].photoKeys).toEqual(["p1"]);
    expect(panelProps[0].videoKeys).toEqual([]);
  });

  it("defaults to empty key arrays when no initial keys given", () => {
    render(<SingleUnitMediaPanel listingId="u2" />);
    expect(panelProps).toHaveLength(1);
    expect(panelProps[0].photoKeys).toEqual([]);
    expect(panelProps[0].videoKeys).toEqual([]);
  });
});

// Fix C — SingleUnitMediaPanel gains an optional onMediaChanged callback that
// fires on every server-confirmed media change (add/delete) but NOT on the
// initial mount, and reads the callback through a ref so a new callback
// identity per parent render does not re-fire it.
describe("SingleUnitMediaPanel — onMediaChanged (Fix C)", () => {
  it("does not fire onMediaChanged on initial mount", () => {
    const onMediaChanged = vi.fn();
    render(
      <SingleUnitMediaPanel
        listingId="u1"
        initialPhotoKeys={["p1"]}
        onMediaChanged={onMediaChanged}
      />,
    );
    expect(onMediaChanged).not.toHaveBeenCalled();
  });

  it("fires onMediaChanged once with the new keys when the panel reports a photo-key change", async () => {
    const user = userEvent.setup();
    const onMediaChanged = vi.fn();
    const { getByText } = render(
      <SingleUnitMediaPanel
        listingId="u1"
        initialPhotoKeys={["p1"]}
        initialVideoKeys={["v1"]}
        onMediaChanged={onMediaChanged}
      />,
    );
    await user.click(getByText("set-photo-u1"));
    expect(onMediaChanged).toHaveBeenCalledTimes(1);
    expect(onMediaChanged).toHaveBeenCalledWith({ photoKeys: ["new-p"], videoKeys: ["v1"] });
  });

  it("fires onMediaChanged with the new keys when the panel reports a video-key change", async () => {
    const user = userEvent.setup();
    const onMediaChanged = vi.fn();
    const { getByText } = render(
      <SingleUnitMediaPanel
        listingId="u1"
        initialPhotoKeys={["p1"]}
        initialVideoKeys={["v1"]}
        onMediaChanged={onMediaChanged}
      />,
    );
    await user.click(getByText("set-video-u1"));
    expect(onMediaChanged).toHaveBeenCalledTimes(1);
    expect(onMediaChanged).toHaveBeenCalledWith({ photoKeys: ["p1"], videoKeys: ["new-v"] });
  });

  it("does not re-fire when only the onMediaChanged identity changes across a parent re-render (same keys)", () => {
    const first = vi.fn();
    const { rerender } = render(
      <SingleUnitMediaPanel listingId="u1" initialPhotoKeys={["p1"]} onMediaChanged={first} />,
    );
    const second = vi.fn();
    rerender(
      <SingleUnitMediaPanel listingId="u1" initialPhotoKeys={["p1"]} onMediaChanged={second} />,
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("does not crash when no onMediaChanged is passed and a key change fires (backward compat)", async () => {
    const user = userEvent.setup();
    const { getByText } = render(<SingleUnitMediaPanel listingId="u1" initialPhotoKeys={["p1"]} />);
    await expect(user.click(getByText("set-photo-u1"))).resolves.not.toThrow();
  });

  // Adversarial-audit finding C6: the app renders inside <StrictMode>
  // (main.tsx), which in dev double-invokes every effect on mount (setup ->
  // cleanup -> setup again, same commit, same closure values). A naive
  // boolean "seeded" flag flips to false on the FIRST invocation and stays
  // false for the second — so the second invocation would wrongly conclude
  // "this is a real change" and fire onMediaChanged with the unchanged
  // initial keys. This must NOT happen under StrictMode.
  it("does not fire onMediaChanged on mount under StrictMode's dev double-invoked effect", () => {
    const onMediaChanged = vi.fn();
    render(
      <StrictMode>
        <SingleUnitMediaPanel
          listingId="u1"
          initialPhotoKeys={["p1"]}
          onMediaChanged={onMediaChanged}
        />
      </StrictMode>,
    );
    expect(onMediaChanged).not.toHaveBeenCalled();
  });
});

describe("CreateUnitMediaStep", () => {
  it("renders one panel and no tablist for a single room", () => {
    const { queryByRole, getByTestId } = render(
      <CreateUnitMediaStep rooms={[{ id: "u1", label: "Studio" }]} onDone={() => {}} />,
    );
    expect(queryByRole("tablist")).toBeNull();
    // A lone panel with no owning tab is an invalid ARIA tabpanel — the
    // single-room case must render a plain container, not a tab role.
    expect(queryByRole("tabpanel")).toBeNull();
    expect(getByTestId("panel").getAttribute("data-listing-id")).toBe("u1");
  });

  it("renders 3 tabs + 3 mounted panels, one per listingId", () => {
    const rooms = [
      { id: "a", label: "Master" },
      { id: "b", label: "Medium" },
      { id: "c", label: "Small" },
    ];
    const { getAllByRole } = render(<CreateUnitMediaStep rooms={rooms} onDone={() => {}} />);
    expect(getAllByRole("tab")).toHaveLength(3);
    const ids = panelProps.map((p) => p.listingId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("keeps only the active tabpanel visible in a 3-room partition", () => {
    const rooms = [
      { id: "a", label: "Master" },
      { id: "b", label: "Medium" },
      { id: "c", label: "Small" },
    ];
    const { getAllByRole } = render(<CreateUnitMediaStep rooms={rooms} onDone={() => {}} />);
    const panels = getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(3);
    // Room "a" is active by default (index 0): its panel is visible, the
    // other two carry the `hidden` attribute so switching tabs never
    // remounts an inactive panel mid-upload.
    expect(panels[0].hasAttribute("hidden")).toBe(false);
    expect(panels[1].hasAttribute("hidden")).toBe(true);
    expect(panels[2].hasAttribute("hidden")).toBe(true);
  });

  it("renders each room's label as tab text", () => {
    const rooms = [
      { id: "a", label: "Master" },
      { id: "b", label: "Medium" },
      { id: "c", label: "Small" },
    ];
    const { getByRole } = render(<CreateUnitMediaStep rooms={rooms} onDone={() => {}} />);
    expect(getByRole("tab", { name: "Master" })).toBeInTheDocument();
    expect(getByRole("tab", { name: "Medium" })).toBeInTheDocument();
    expect(getByRole("tab", { name: "Small" })).toBeInTheDocument();
  });

  it("ArrowRight moves the active tab, wrapping from last to first", async () => {
    const user = userEvent.setup();
    const rooms = [
      { id: "a", label: "Master" },
      { id: "b", label: "Medium" },
      { id: "c", label: "Small" },
    ];
    const { getAllByRole } = render(<CreateUnitMediaStep rooms={rooms} onDone={() => {}} />);
    const tabs = getAllByRole("tab");
    await user.click(tabs[0]);

    await user.keyboard("{ArrowRight}");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowRight}");
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");

    // wraps last -> first
    await user.keyboard("{ArrowRight}");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowLeft wraps from first to last; Home/End jump to the ends", async () => {
    const user = userEvent.setup();
    const rooms = [
      { id: "a", label: "Master" },
      { id: "b", label: "Medium" },
      { id: "c", label: "Small" },
    ];
    const { getAllByRole } = render(<CreateUnitMediaStep rooms={rooms} onDone={() => {}} />);
    const tabs = getAllByRole("tab");
    await user.click(tabs[0]);

    // wraps first -> last
    await user.keyboard("{ArrowLeft}");
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{Home}");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{End}");
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
  });

  it("roving tabIndex follows the active tab", async () => {
    const user = userEvent.setup();
    const rooms = [
      { id: "a", label: "Master" },
      { id: "b", label: "Medium" },
      { id: "c", label: "Small" },
    ];
    const { getAllByRole } = render(<CreateUnitMediaStep rooms={rooms} onDone={() => {}} />);
    const tabs = getAllByRole("tab");
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
    expect(tabs[2].getAttribute("tabindex")).toBe("-1");

    await user.click(tabs[0]);
    await user.keyboard("{ArrowRight}");
    expect(tabs[0].getAttribute("tabindex")).toBe("-1");
    expect(tabs[1].getAttribute("tabindex")).toBe("0");
  });

  it("Done fires onDone once", async () => {
    const onDone = vi.fn();
    const { getByRole } = render(
      <CreateUnitMediaStep rooms={[{ id: "u1", label: "Studio" }]} onDone={onDone} />,
    );
    await userEvent.click(getByRole("button", { name: /done/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
