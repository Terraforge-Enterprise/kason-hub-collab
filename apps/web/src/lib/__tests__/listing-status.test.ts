import { describe, it, expect } from "vitest";
import {
  compositeStatusLabel,
  isListedToAgents,
  LISTING_STATUS_ORDER,
  listingLabel,
  occupancyLabel,
  sortByListingStatus,
  type ListingLifecycle,
} from "../listing-status";

type UnitLifecycle = ListingLifecycle;

describe("occupancyLabel", () => {
  it.each([
    ["vacant", "Vacant"],
    ["occupied", "Occupied"],
    ["reserved", "Reserved"],
    ["maintenance", "Maintenance"],
    ["unknown_state", "unknown_state"], // falls through to raw value
  ])("%s → %s", (raw, expected) => {
    expect(occupancyLabel(raw)).toBe(expected);
  });
});

describe("listingLabel", () => {
  it("maps the schema enum to friendly labels", () => {
    expect(listingLabel("draft")).toBe("Draft");
    expect(listingLabel("active")).toBe("Active");
    // The internal enum stays "archived" for back-compat with existing
    // queries; the UI label renders as "Deactivated" since that conveys
    // the admin-action intent (reversible) better than "Archived".
    expect(listingLabel("archived")).toBe("Deactivated");
  });
  it("legacy 'published' renders as Active", () => {
    expect(listingLabel("published")).toBe("Active");
  });
});

describe("compositeStatusLabel", () => {
  const base: UnitLifecycle = {
    occupancyStatus: "vacant",
    listingStatus: "active",
    visibilityMode: "PUBLIC",
    readyNow: false,
  };

  it("returns 'Ready Now' when readyNow=true", () => {
    expect(compositeStatusLabel({ ...base, readyNow: true })).toBe("Ready Now");
  });

  it("returns Ready Now when readyNow=true even if listingStatus=draft", () => {
    expect(compositeStatusLabel({
      readyNow: true,
      listingStatus: "draft",
      occupancyStatus: "vacant",
    })).toBe("Ready Now");
  });

  it("appends · Draft when listingStatus=draft", () => {
    expect(compositeStatusLabel({ ...base, listingStatus: "draft" })).toBe("Vacant · Draft");
  });

  it("appends · Deactivated when listingStatus=archived (UI label)", () => {
    expect(compositeStatusLabel({ ...base, listingStatus: "archived" })).toBe(
      "Vacant · Deactivated",
    );
  });

  it("Deactivated wins over Ready Now (admin-action state is stronger signal)", () => {
    // A deactivated listing must never display as Ready Now — that would
    // imply bookability. The deactivated branch in compositeStatusLabel
    // short-circuits before the readyNow check.
    expect(
      compositeStatusLabel({
        readyNow: true,
        listingStatus: "archived",
        occupancyStatus: "vacant",
      }),
    ).toBe("Vacant · Deactivated");
  });

  it("appends · Private when visibilityMode=RESTRICTED", () => {
    expect(
      compositeStatusLabel({
        ...base,
        listingStatus: "active",
        visibilityMode: "RESTRICTED",
      }),
    ).toBe("Vacant · Private");
  });

  it("returns plain occupancy when active+public+not-ready (e.g., occupied)", () => {
    expect(
      compositeStatusLabel({
        ...base,
        occupancyStatus: "occupied",
      }),
    ).toBe("Occupied");
  });
});

describe("isListedToAgents", () => {
  it("true when listingStatus=active AND occupancyStatus=vacant", () => {
    expect(isListedToAgents({ listingStatus: "active", occupancyStatus: "vacant" })).toBe(true);
  });
  it("true even when RESTRICTED — visibility is not part of this gate", () => {
    // Per client direction: a unit is "listed" when it's an active listing
    // on a vacant unit, regardless of who can see it. RESTRICTED governs
    // per-agent visibility, not whether the unit is listed.
    expect(isListedToAgents({ listingStatus: "active", occupancyStatus: "vacant" })).toBe(true);
  });
  it("false when draft", () => {
    expect(isListedToAgents({ listingStatus: "draft", occupancyStatus: "vacant" })).toBe(false);
  });
  it("false when archived", () => {
    expect(isListedToAgents({ listingStatus: "archived", occupancyStatus: "vacant" })).toBe(false);
  });
  it("false when occupied", () => {
    expect(isListedToAgents({ listingStatus: "active", occupancyStatus: "occupied" })).toBe(false);
  });
  it("false when reserved", () => {
    expect(isListedToAgents({ listingStatus: "active", occupancyStatus: "reserved" })).toBe(false);
  });
  it("false when in maintenance", () => {
    expect(isListedToAgents({ listingStatus: "active", occupancyStatus: "maintenance" })).toBe(false);
  });
  it("false when listingStatus is the legacy 'published' (not the canonical 'active')", () => {
    // Hard rule from lessons: name the value set you expect at the call site.
    // "listed" means listingStatus is the canonical "active".
    expect(isListedToAgents({ listingStatus: "published", occupancyStatus: "vacant" })).toBe(false);
  });
});

describe("sortByListingStatus", () => {
  it("orders active → draft → archived (deactivated)", () => {
    const rows = [
      { id: "a", listingStatus: "archived" },
      { id: "b", listingStatus: "active" },
      { id: "c", listingStatus: "draft" },
    ];
    const sorted = sortByListingStatus(rows);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
  it("unknown statuses sort to the end (preserves relative order between unknowns)", () => {
    const rows = [
      { id: "a", listingStatus: "active" },
      { id: "b", listingStatus: "unknown" },
      { id: "c", listingStatus: "draft" },
    ];
    const sorted = sortByListingStatus(rows);
    expect(sorted.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  it("exposes the canonical order array for callers that need it directly", () => {
    expect(LISTING_STATUS_ORDER).toEqual(["active", "draft", "archived"]);
  });
});
