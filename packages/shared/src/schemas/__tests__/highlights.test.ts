// Highlights field validation — 2026-05-13 apartment-aggregation-and-
// highlights design spec. The field is free-form (no catalog gate) but the
// schema must defensively bound input shape so a hostile client can't
// bypass the UI's TagInput limits.
//
// Rules under test:
//   - per-tag: trim, min 1 char post-trim, max 60 chars
//   - per-unit: max 10 tags
//   - server dedupes (set semantics)
//   - field is optional everywhere

import { describe, it, expect } from "vitest";
import { createUnitsBatchSchema } from "../inventory";

// Valid UUIDv4 (Zod v4's .uuid() enforces the v4 bit pattern: third group
// starts with "4", fourth group starts with "8"-"b").
const VALID_UUID = "00000000-0000-4000-8000-000000000001";

function basePayload(overrides: { highlights?: unknown }) {
  return {
    shared: {
      propertyId: VALID_UUID,
      unitCode: "C-12-34",
      ...overrides,
    },
    // depositMonths + utilitiesDepositMonths are required on every batch room
    // (see batchRoomFields → requiredDepositMonths / requiredUtilitiesDepositMonths).
    // The test was written before these became required and needs the canonical
    // minimum payload now to exercise the highlights branch.
    rooms: [{ unitType: "Master", depositMonths: 2, utilitiesDepositMonths: 1 }],
  };
}

describe("Highlights — Zod schema constraints", () => {
  it("accepts an absent highlights field (legacy callers / no taglines)", () => {
    const r = createUnitsBatchSchema.safeParse(basePayload({}));
    expect(r.success).toBe(true);
  });

  it("accepts an empty highlights array", () => {
    const r = createUnitsBatchSchema.safeParse(basePayload({ highlights: [] }));
    expect(r.success).toBe(true);
  });

  it("accepts up to 10 tags per apartment", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    const r = createUnitsBatchSchema.safeParse(basePayload({ highlights: tags }));
    expect(r.success).toBe(true);
  });

  it("rejects 11 or more tags per apartment", () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    const r = createUnitsBatchSchema.safeParse(basePayload({ highlights: tags }));
    expect(r.success).toBe(false);
  });

  it("rejects a tag longer than 60 characters", () => {
    const longTag = "x".repeat(61);
    const r = createUnitsBatchSchema.safeParse(basePayload({ highlights: [longTag] }));
    expect(r.success).toBe(false);
  });

  it("accepts a 60-character tag at the boundary", () => {
    const tag = "x".repeat(60);
    const r = createUnitsBatchSchema.safeParse(basePayload({ highlights: [tag] }));
    expect(r.success).toBe(true);
  });

  it("trims whitespace from each tag and rejects empty-after-trim", () => {
    const r1 = createUnitsBatchSchema.safeParse(basePayload({ highlights: ["   "] }));
    expect(r1.success).toBe(false);

    const r2 = createUnitsBatchSchema.safeParse(basePayload({ highlights: ["  Near KLCC  "] }));
    expect(r2.success).toBe(true);
    if (r2.success) {
      expect(r2.data.shared.highlights).toEqual(["Near KLCC"]);
    }
  });

  it("deduplicates tags via set-style transform (defensive vs hostile clients)", () => {
    const r = createUnitsBatchSchema.safeParse(
      basePayload({ highlights: ["Near KLCC", "Corner unit", "Near KLCC"] }),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      // Order preserved on first appearance; duplicate dropped.
      expect(r.data.shared.highlights).toEqual(["Near KLCC", "Corner unit"]);
    }
  });

  it("rejects non-string entries", () => {
    const r = createUnitsBatchSchema.safeParse(
      basePayload({ highlights: ["Valid", 42, null] as unknown as string[] }),
    );
    expect(r.success).toBe(false);
  });
});
