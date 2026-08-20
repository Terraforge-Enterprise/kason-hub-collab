import { describe, it, expect } from "vitest";
import { DAY_MS, todayStart, classifyDue, isOverdue, daysUntil } from "../tasks-due";

const dayStart = todayStart();

describe("classifyDue", () => {
  it("a timestamp before today's start is overdue", () => {
    expect(classifyDue(new Date(dayStart - 2 * DAY_MS).toISOString())).toBe("overdue");
  });
  it("a timestamp within today is today", () => {
    expect(classifyDue(new Date(dayStart + 12 * 60 * 60 * 1000).toISOString())).toBe("today");
  });
  it("a timestamp 3 days out is this week", () => {
    expect(classifyDue(new Date(dayStart + 3 * DAY_MS).toISOString())).toBe("week");
  });
  it("a timestamp beyond 7 days is null", () => {
    expect(classifyDue(new Date(dayStart + 10 * DAY_MS).toISOString())).toBeNull();
  });
});

describe("isOverdue", () => {
  it("null is never overdue", () => {
    expect(isOverdue(null)).toBe(false);
  });
  it("a past due date is overdue", () => {
    expect(isOverdue(new Date(dayStart - DAY_MS).toISOString())).toBe(true);
  });
});

describe("daysUntil", () => {
  it("returns 0 for a date inside today", () => {
    expect(daysUntil(new Date(dayStart + 6 * 60 * 60 * 1000).toISOString())).toBe(0);
  });
  it("returns a positive whole-day count for a future date", () => {
    expect(daysUntil(new Date(dayStart + 5 * DAY_MS).toISOString())).toBe(5);
  });
  it("returns a negative count for a past date", () => {
    expect(daysUntil(new Date(dayStart - 2 * DAY_MS).toISOString())).toBe(-2);
  });
});
