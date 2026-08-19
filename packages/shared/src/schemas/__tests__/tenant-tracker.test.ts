// Tenant Tracker (M1) — query/body contract validation.
// Plan: docs/superpowers/plans/2026-06-11-phase2-tenant-tracker.md (Step 1).
//
// Rules under test:
//   - list query: status enum defaults to "active"; rejects unknown values
//   - list query: limit coerces strings, int, min 1, max 100, default 25
//   - list query: agent/roomType/q/phone/cursor all optional
//   - lookup query: phone requires at least 4 chars
//   - assign in-charge: nullable uuid (null = unassign) + optional
//     ISO-datetime optimistic-concurrency token

import { describe, it, expect } from "vitest";
import {
  tenantTrackerListQuerySchema,
  tenantTrackerLookupQuerySchema,
  assignInChargeSchema,
  icRevealBodySchema,
} from "../tenant-tracker";

// Valid UUID (Zod 4's .uuid() accepts RFC-9562 UUIDs of versions 1-8 plus
// the nil UUID; it enforces the variant bits — fourth group starts with
// "8"-"b" — but NOT a specific version).
const VALID_UUID = "00000000-0000-4000-8000-000000000001";

describe("tenantTrackerListQuerySchema", () => {
  it("defaults status to \"active\" when absent", () => {
    const r = tenantTrackerListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe("active");
  });

  it("accepts each allowed status value", () => {
    for (const status of ["active", "ended", "all"]) {
      const r = tenantTrackerListQuerySchema.safeParse({ status });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.status).toBe(status);
    }
  });

  it("rejects status \"deleted\"", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ status: "deleted" });
    expect(r.success).toBe(false);
  });

  it("coerces limit \"25\" to the number 25", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ limit: "25" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(25);
  });

  it("defaults limit to 25 when absent", () => {
    const r = tenantTrackerListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(25);
  });

  it("rejects limit 0 (min 1)", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ limit: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects limit 150 (max 100)", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ limit: 150 });
    expect(r.success).toBe(false);
  });

  it("accepts limit 1 (lower boundary)", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ limit: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(1);
  });

  it("accepts limit 100 (upper boundary)", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ limit: 100 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(100);
  });

  it("rejects a non-numeric limit \"abc\"", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ limit: "abc" });
    expect(r.success).toBe(false);
  });

  it("treats agent/roomType/q/phone/cursor as optional", () => {
    const r = tenantTrackerListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.agent).toBeUndefined();
      expect(r.data.roomType).toBeUndefined();
      expect(r.data.q).toBeUndefined();
      expect(r.data.phone).toBeUndefined();
      expect(r.data.cursor).toBeUndefined();
    }
  });

  it("passes through agent/roomType/q/phone/cursor when supplied", () => {
    const r = tenantTrackerListQuerySchema.safeParse({
      propertyId: VALID_UUID,
      agent: "Yannie",
      roomType: "Master",
      q: "Tan",
      phone: "1234",
      cursor: "opaque-cursor",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.agent).toBe("Yannie");
      expect(r.data.roomType).toBe("Master");
      expect(r.data.q).toBe("Tan");
      expect(r.data.phone).toBe("1234");
      expect(r.data.cursor).toBe("opaque-cursor");
    }
  });

  it("rejects a non-uuid propertyId", () => {
    const r = tenantTrackerListQuerySchema.safeParse({ propertyId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
});

describe("tenantTrackerLookupQuerySchema", () => {
  it("accepts a 4-char phone fragment", () => {
    const r = tenantTrackerLookupQuerySchema.safeParse({ phone: "1234" });
    expect(r.success).toBe(true);
  });

  it("rejects a phone shorter than 4 chars", () => {
    const r = tenantTrackerLookupQuerySchema.safeParse({ phone: "123" });
    expect(r.success).toBe(false);
  });

  it("rejects a missing phone", () => {
    const r = tenantTrackerLookupQuerySchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe("assignInChargeSchema", () => {
  it("rejects an empty body — inChargePartyId is nullable but REQUIRED", () => {
    // The subtle semantic: null means "unassign", so the key must always be
    // present; omitting it is a malformed request, not a no-op.
    const r = assignInChargeSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("accepts null (unassign)", () => {
    const r = assignInChargeSchema.safeParse({ inChargePartyId: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.inChargePartyId).toBeNull();
  });

  it("accepts a uuid", () => {
    const r = assignInChargeSchema.safeParse({ inChargePartyId: VALID_UUID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.inChargePartyId).toBe(VALID_UUID);
  });

  it("rejects a non-uuid string", () => {
    const r = assignInChargeSchema.safeParse({ inChargePartyId: "party-007" });
    expect(r.success).toBe(false);
  });

  it("accepts an ISO datetime expectedUpdatedAt", () => {
    const r = assignInChargeSchema.safeParse({
      inChargePartyId: VALID_UUID,
      expectedUpdatedAt: "2026-06-12T03:04:05.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a garbage expectedUpdatedAt", () => {
    const r = assignInChargeSchema.safeParse({
      inChargePartyId: VALID_UUID,
      expectedUpdatedAt: "yesterday-ish",
    });
    expect(r.success).toBe(false);
  });

  it("treats expectedUpdatedAt as optional", () => {
    const r = assignInChargeSchema.safeParse({ inChargePartyId: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.expectedUpdatedAt).toBeUndefined();
  });
});

describe("icRevealBodySchema", () => {
  it("accepts a uuid partyId", () => {
    const r = icRevealBodySchema.safeParse({ partyId: VALID_UUID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.partyId).toBe(VALID_UUID);
  });

  it("rejects a non-uuid partyId", () => {
    const r = icRevealBodySchema.safeParse({ partyId: "party-007" });
    expect(r.success).toBe(false);
  });

  it("rejects a missing partyId", () => {
    const r = icRevealBodySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects a null partyId (no unassign semantics on reveal)", () => {
    const r = icRevealBodySchema.safeParse({ partyId: null });
    expect(r.success).toBe(false);
  });
});

describe("tenantTrackerListQuerySchema period", () => {
  it("accepts a YYYY-MM period", () => {
    expect(tenantTrackerListQuerySchema.parse({ period: "2026-06" }).period).toBe("2026-06");
  });
  it("rejects a non-YYYY-MM period", () => {
    expect(tenantTrackerListQuerySchema.safeParse({ period: "June" }).success).toBe(false);
  });
  it("leaves period undefined when omitted (service defaults to current month)", () => {
    expect(tenantTrackerListQuerySchema.parse({}).period).toBeUndefined();
  });
});
