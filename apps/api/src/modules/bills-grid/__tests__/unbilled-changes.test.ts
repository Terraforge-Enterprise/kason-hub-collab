// Truth table for deriveHasUnbilledChanges — the marker that stops a billed-but-unpaid
// amend from being silently forgotten after the 2026-08-17 unlock.
//
// Pure fold over data the read path already loads; no DB. The rule under test is
// deliberately BIASED TO DIRTY: a false positive costs one re-Bill that returns
// `already_billed` and mutates nothing, while a false negative leaves money off an
// invoice. Every ambiguous case below therefore expects `true`.
import { describe, expect, it } from "vitest";
import { deriveHasUnbilledChanges } from "../service";

const BILLED = new Date("2026-08-17T10:00:00.000Z");
const BEFORE = new Date("2026-08-17T09:00:00.000Z");
const AFTER = new Date("2026-08-17T11:00:00.000Z");

type Entry = Parameters<typeof deriveHasUnbilledChanges>[0];

/** Minimal entry carrying only the fields the derivation reads. */
function entry(parts: {
  billedAt?: Date | null;
  updatedAt?: Date;
  readings?: { createdAt: Date; updatedAt: Date }[];
  expenses?: { createdAt: Date; updatedAt: Date }[];
  attachments?: { createdAt: Date }[];
}): Entry {
  return {
    billedAt: parts.billedAt === undefined ? BILLED : parts.billedAt,
    updatedAt: parts.updatedAt ?? BEFORE,
    readings: parts.readings ?? [],
    expenses: parts.expenses ?? [],
    attachments: parts.attachments ?? [],
  } as unknown as Entry;
}

describe("deriveHasUnbilledChanges", () => {
  it("null entry (apartment-month never saved) → false", () => {
    expect(deriveHasUnbilledChanges(null)).toBe(false);
  });

  it("never billed → false, even with children newer than everything", () => {
    // Nothing has been invoiced, so there is no invoice for the row to diverge FROM.
    // An unbilled row is edited constantly; marking it would make the tag meaningless.
    expect(deriveHasUnbilledChanges(entry({
      billedAt: null,
      updatedAt: AFTER,
      expenses: [{ createdAt: AFTER, updatedAt: AFTER }],
    }))).toBe(false);
  });

  it("billed, nothing touched since → false", () => {
    expect(deriveHasUnbilledChanges(entry({
      readings: [{ createdAt: BEFORE, updatedAt: BEFORE }],
      expenses: [{ createdAt: BEFORE, updatedAt: BEFORE }],
      attachments: [{ createdAt: BEFORE }],
    }))).toBe(false);
  });

  it("billed, then an expense ADDED → true (the forget-to-re-Bill case this exists for)", () => {
    expect(deriveHasUnbilledChanges(entry({
      expenses: [{ createdAt: AFTER, updatedAt: AFTER }],
    }))).toBe(true);
  });

  it("billed, then an existing expense EDITED or VOIDED → true", () => {
    // A void is an UPDATE (status -> "void"), so it lands on updatedAt with the original
    // createdAt intact. This is the case voidExpenseService used to prevent outright.
    expect(deriveHasUnbilledChanges(entry({
      expenses: [{ createdAt: BEFORE, updatedAt: AFTER }],
    }))).toBe(true);
  });

  it("billed, then a reading edited → true", () => {
    expect(deriveHasUnbilledChanges(entry({
      readings: [{ createdAt: BEFORE, updatedAt: AFTER }],
    }))).toBe(true);
  });

  it("billed, then the entry itself edited (bearer/pattern change) → true", () => {
    expect(deriveHasUnbilledChanges(entry({ updatedAt: AFTER }))).toBe(true);
  });

  it("billed, then an attachment added → true, via createdAt (GridAttachment has no updatedAt)", () => {
    expect(deriveHasUnbilledChanges(entry({
      attachments: [{ createdAt: AFTER }],
    }))).toBe(true);
  });

  it("one dirty child among many clean ones → true", () => {
    expect(deriveHasUnbilledChanges(entry({
      readings: [{ createdAt: BEFORE, updatedAt: BEFORE }, { createdAt: BEFORE, updatedAt: BEFORE }],
      expenses: [{ createdAt: BEFORE, updatedAt: BEFORE }, { createdAt: AFTER, updatedAt: AFTER }],
      attachments: [{ createdAt: BEFORE }],
    }))).toBe(true);
  });

  it("billed with no children at all → false, and does not throw on the empty arrays", () => {
    expect(deriveHasUnbilledChanges(entry({}))).toBe(false);
  });

  it("a child touched at EXACTLY billedAt → false (strictly newer, not newer-or-equal)", () => {
    // The Bill itself writes the entry, so `updatedAt === billedAt` is the normal
    // just-billed state. Treating equality as dirty would mark every freshly billed row.
    expect(deriveHasUnbilledChanges(entry({
      updatedAt: BILLED,
      expenses: [{ createdAt: BILLED, updatedAt: BILLED }],
    }))).toBe(false);
  });

  it("a re-Bill clears it: children fall behind the NEW billedAt", () => {
    // rebillSupersedeTx stamps a fresh billedAt, so yesterday's amend is no longer newer.
    const reBilledAt = new Date("2026-08-17T12:00:00.000Z");
    expect(deriveHasUnbilledChanges(entry({
      billedAt: reBilledAt,
      updatedAt: AFTER,
      expenses: [{ createdAt: AFTER, updatedAt: AFTER }],
    }))).toBe(false);
  });
});
