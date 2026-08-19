// Pure-unit tests for the tenant-tracker repository helpers (no DB).
// DB-hitting coverage lives in repository.integration.test.ts (RUN_INTEGRATION=1).
import { describe, expect, it } from "vitest";
import {
  buildCursorWhere,
  buildPhoneMatchWhere,
  decodeTrackerCursor,
  encodeTrackerCursor,
  tenancyStatusWhere,
} from "../repository";
import type { TrackerCursor } from "../types";

describe("tracker cursor encode/decode", () => {
  const cursor: TrackerCursor = {
    propertyName: "M Vertica",
    unitCode: "A-10-3A",
    apartmentId: "11111111-1111-4111-8111-111111111111",
  };

  it("round-trips", () => {
    expect(decodeTrackerCursor(encodeTrackerCursor(cursor))).toEqual(cursor);
  });

  it("round-trips unicode + URL-hostile characters", () => {
    const odd: TrackerCursor = {
      propertyName: "Résidence 中文 / + & ?",
      unitCode: "B/2-3A",
      apartmentId: "22222222-2222-4222-8222-222222222222",
    };
    expect(decodeTrackerCursor(encodeTrackerCursor(odd))).toEqual(odd);
  });

  it("produces an opaque, URL-safe base64url string (no raw JSON)", () => {
    const encoded = encodeTrackerCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
    expect(encoded).not.toContain("M Vertica");
  });

  it("returns null for garbage input", () => {
    expect(decodeTrackerCursor("not-base64-json")).toBeNull();
    expect(decodeTrackerCursor("")).toBeNull();
  });

  it("returns null for valid base64 JSON with missing/wrong-typed keys", () => {
    const bad = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(decodeTrackerCursor(bad({ propertyName: "X" }))).toBeNull();
    expect(
      decodeTrackerCursor(bad({ propertyName: "X", unitCode: "Y", apartmentId: 7 })),
    ).toBeNull();
    expect(decodeTrackerCursor(bad(null))).toBeNull();
    expect(decodeTrackerCursor(bad("string"))).toBeNull();
    expect(decodeTrackerCursor(bad([1, 2, 3]))).toBeNull();
  });

  it("ignores extra keys but keeps only the cursor fields", () => {
    const extra = Buffer.from(
      JSON.stringify({ ...cursor, evil: "x" }),
      "utf8",
    ).toString("base64url");
    expect(decodeTrackerCursor(extra)).toEqual(cursor);
  });
});

describe("buildCursorWhere — strictly-after tuple comparison", () => {
  it("builds the three-branch OR", () => {
    const where = buildCursorWhere({
      propertyName: "P",
      unitCode: "U",
      apartmentId: "ID",
    });
    expect(where).toEqual({
      OR: [
        { property: { name: { gt: "P" } } },
        { property: { name: "P" }, unitCode: { gt: "U" } },
        { property: { name: "P" }, unitCode: "U", id: { gt: "ID" } },
      ],
    });
  });
});

describe("tenancyStatusWhere", () => {
  it('active → status === "active"', () => {
    expect(tenancyStatusWhere("active")).toEqual({ status: "active" });
  });

  it('ended → status !== "active" (catches "terminated")', () => {
    expect(tenancyStatusWhere("ended")).toEqual({ status: { not: "active" } });
  });

  it("all → no condition", () => {
    expect(tenancyStatusWhere("all")).toEqual({});
  });
});

describe("buildPhoneMatchWhere", () => {
  it("full valid MY number → canonical-only condition (canonical === digits)", () => {
    expect(buildPhoneMatchWhere("60123456789", "contains")).toEqual({
      primaryPhone: { contains: "60123456789" },
    });
  });

  it("formatted full number → canonical + raw-digit OR (digits still carry the 0-prefix form)", () => {
    expect(buildPhoneMatchWhere("012-345 6789", "contains")).toEqual({
      OR: [
        { primaryPhone: { contains: "60123456789" } },
        { primaryPhone: { contains: "0123456789" } },
      ],
    });
  });

  it("national prefix fragment → plain digits (not a valid full number)", () => {
    expect(buildPhoneMatchWhere("010", "contains")).toEqual({
      primaryPhone: { contains: "010" },
    });
  });

  it("canonicalization hijack: 9-digit fragment that parses as a full mobile keeps the raw arm", () => {
    // Last 9 digits of stored 601123456789; normalizeMyPhone("123456789")
    // reinterprets it as 60123456789 — without the raw arm this is a false
    // negative (spec §3.1).
    expect(buildPhoneMatchWhere("123456789", "contains")).toEqual({
      OR: [
        { primaryPhone: { contains: "60123456789" } },
        { primaryPhone: { contains: "123456789" } },
      ],
    });
  });

  it("supports endsWith for the lookup's suffix-ranked first query", () => {
    expect(buildPhoneMatchWhere("6780", "endsWith")).toEqual({
      primaryPhone: { endsWith: "6780" },
    });
  });

  it("no digits → null", () => {
    expect(buildPhoneMatchWhere("abc", "contains")).toBeNull();
    expect(buildPhoneMatchWhere("", "contains")).toBeNull();
  });
});
