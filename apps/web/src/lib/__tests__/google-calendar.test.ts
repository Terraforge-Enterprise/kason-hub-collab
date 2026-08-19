import { describe, it, expect } from "vitest";
import { buildGoogleCalendarUrl } from "../google-calendar";

describe("buildGoogleCalendarUrl", () => {
  it("spans a UTC month boundary correctly (day → day+1)", () => {
    const url = buildGoogleCalendarUrl({
      title: "Renew fire cert",
      dueOn: "2026-06-30T23:00:00.000Z",
    });
    const params = new URL(url).searchParams;
    expect(params.get("dates")).toBe("20260630/20260701");
  });

  it("yields day/day+1 for an ordinary date", () => {
    const url = buildGoogleCalendarUrl({
      title: "Inspect unit",
      dueOn: "2026-06-15T00:00:00.000Z",
    });
    const params = new URL(url).searchParams;
    expect(params.get("dates")).toBe("20260615/20260616");
    expect(params.get("action")).toBe("TEMPLATE");
  });

  it("URL-encodes the title", () => {
    const url = buildGoogleCalendarUrl({
      title: "Fix A&B / unit #12",
      dueOn: "2026-06-15T00:00:00.000Z",
    });
    // Raw querystring must not contain the unencoded specials…
    const qs = url.split("?")[1];
    expect(qs).not.toContain("A&B");
    expect(qs).not.toContain("#12");
    // …but it must round-trip back to the original title.
    expect(new URL(url).searchParams.get("text")).toBe("Fix A&B / unit #12");
  });

  it("includes details only when provided", () => {
    const withDetails = buildGoogleCalendarUrl({
      title: "T",
      dueOn: "2026-06-15T00:00:00.000Z",
      details: "Bring ladder",
    });
    expect(new URL(withDetails).searchParams.get("details")).toBe("Bring ladder");

    const withoutDetails = buildGoogleCalendarUrl({
      title: "T",
      dueOn: "2026-06-15T00:00:00.000Z",
    });
    expect(new URL(withoutDetails).searchParams.has("details")).toBe(false);
  });
});
