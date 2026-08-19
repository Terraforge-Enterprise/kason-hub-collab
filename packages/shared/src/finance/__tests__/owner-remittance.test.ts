// Task 4 (Phase-2 owner remittance) — canonicalJSON, computeRequestFingerprint, and the
// 4 Zod request schemas (remittanceCreateSchema, remittanceAllocateSchema, offsetCreateSchema,
// reverseSchema). Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md
// (Task 4; R25 idempotency fingerprint design decision #1; GC2/GC6).
//
// Pure @kason/shared module: NO DB, NO API. Money fields are 2dp decimal STRINGS validated
// > 0; integer-cents conversion happens later, at the Task-5 service boundary (GC2).
//
// NOTE on the UUID fixtures: Zod v4's `.uuid()` enforces the RFC v4 bit pattern (third group
// starts "4", fourth starts "8"-"b" — see packages/shared/src/schemas/owner-billing.ts:14-18),
// so fixtures below use the codebase's canonical valid-v4 shape.

import { createHash } from "crypto";
import { describe, it, expect } from "vitest";
import { canonicalJSON, computeRequestFingerprint } from "../owner-remittance";
import {
  remittanceCreateSchema,
  remittanceAllocateSchema,
  offsetCreateSchema,
  reverseSchema,
} from "../../schemas/owner-remittance";

// Valid UUIDv4 fixtures (Zod v4's .uuid() enforces the RFC v4 bit pattern — see
// packages/shared/src/schemas/owner-billing.ts:14-18 for the house convention).
const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const PERIOD_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "00000000-0000-4000-8000-000000000003";

const validRemittanceCreate = () => ({
  ownerPartyId: OWNER_ID,
  amount: "300.00",
  effectiveDate: "2026-07-20",
  settlementKind: "OWNER_REMITTANCE" as const,
  paymentMethod: "bank_transfer" as const,
  currency: "MYR" as const,
  allocations: [{ ownerStatementPeriodId: PERIOD_ID, allocatedAmount: "300.00" }],
  idempotencyKey: "00000000-0000-4000-8000-000000000099",
});

describe("canonicalJSON", () => {
  it("sorts object keys recursively so key order does not affect output (B1)", () => {
    const a = { b: 1, a: { y: 2, x: 1 } };
    const b = { a: { x: 1, y: 2 }, b: 1 };
    // Pin the exact expected canonical form — a mutual-equality-only assertion
    // would pass against a stub that always returns the same constant, or an
    // implementation that serializes without sorting (both a and b would still
    // be internally consistent with each other but not with the sorted form).
    expect(canonicalJSON(a)).toBe('{"a":{"x":1,"y":2},"b":1}');
    expect(canonicalJSON(b)).toBe('{"a":{"x":1,"y":2},"b":1}');
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it("preserves array element order — order IS significant (B2)", () => {
    expect(canonicalJSON([1, 2, 3])).not.toBe(canonicalJSON([3, 2, 1]));
  });

  it("serializes primitives and null via JSON escaping (B3)", () => {
    expect(canonicalJSON('a"b')).toBe(JSON.stringify('a"b'));
    expect(canonicalJSON(42)).toBe("42");
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON(null)).toBe("null");
  });

  it("renders empty object and empty array as distinct fixed literals (B4)", () => {
    expect(canonicalJSON({})).toBe("{}");
    expect(canonicalJSON([])).toBe("[]");
    expect(canonicalJSON({})).not.toBe(canonicalJSON([]));
  });

  it("treats an explicit undefined-valued property the same as an omitted key, at every nesting depth (adversarial-audit B19)", () => {
    // A Zod-parsed object with an absent .optional() field vs. one explicitly assigned
    // `undefined` (both mean "not provided") must canonicalize identically — otherwise
    // computeRequestFingerprint could fingerprint two semantically-equal replay requests
    // differently depending on how the client's JSON serializer happened to construct
    // the object (self-review hardening — considered during the adversarial-audit brief).
    const withUndefined = { a: 1, b: undefined as unknown };
    const omitted = { a: 1 };
    expect(canonicalJSON(withUndefined)).toBe(canonicalJSON(omitted));
    expect(canonicalJSON(withUndefined)).toBe('{"a":1}');

    // Nested case (the .filter() is applied on EVERY recursive call, not just the root) —
    // a regression that hoisted the filter out of the recursion would only strip at depth 0.
    const nestedWithUndefined = { outer: { a: 1, b: undefined as unknown, c: 2 } };
    const nestedOmitted = { outer: { a: 1, c: 2 } };
    expect(canonicalJSON(nestedWithUndefined)).toBe(canonicalJSON(nestedOmitted));
    expect(canonicalJSON(nestedWithUndefined)).toBe('{"outer":{"a":1,"c":2}}');
  });

  it("keeps null/undefined array ELEMENTS inline as 'null' rather than dropping them (adversarial-audit B20)", () => {
    // Asymmetric with the object-property case above BY DESIGN — mirrors JSON.stringify's
    // own array behaviour (JSON.stringify([undefined]) === "[null]", never "[]"). Dropping
    // an array element would silently shift every subsequent element's index, corrupting
    // an allocations array; object properties have no such positional meaning, so dropping
    // undefined THERE is safe.
    expect(canonicalJSON([null])).toBe("[null]");
    expect(canonicalJSON([undefined])).toBe("[null]");
    expect(canonicalJSON([1, null, 3])).toBe("[1,null,3]");
  });

  it("sorts numeric-looking string keys lexicographically, not numerically (adversarial-audit B22)", () => {
    // Object.keys(...).sort() is lexicographic (UTF-16 code-unit) by default — "10" sorts
    // BEFORE "9" (since "1" < "9" as characters). Pinning this locks the documented
    // ordering rule against a future "helpful" switch to numeric-aware sorting, which
    // would silently invalidate every previously-stored requestFingerprint for a payload
    // with array-index-like string keys.
    const obj = { "10": "a", "9": "b", "2": "c" };
    expect(canonicalJSON(obj)).toBe('{"10":"a","2":"c","9":"b"}');
  });

  it("collapses null and (top-level) undefined to the identical canonical form (adversarial-audit B18)", () => {
    // Both flow through the v===null||v===undefined base case. Documented as intentional:
    // callers only ever pass a Zod-parsed object (never a bare top-level null/undefined),
    // so this collision has no real call site — pinned here so a future change is a
    // deliberate decision, not an accidental behavior drift.
    expect(canonicalJSON(null)).toBe(canonicalJSON(undefined));
    expect(canonicalJSON(null)).toBe("null");
  });
});

describe("computeRequestFingerprint", () => {
  it("is a sha256 hex digest of the canonical payload (sanity check on shape)", () => {
    const hash = computeRequestFingerprint({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across top-level key reordering (B5 — acceptance row 1)", () => {
    const p1 = { ownerPartyId: "owner-1", amount: "150.00", currency: "MYR" };
    const p2 = { currency: "MYR", amount: "150.00", ownerPartyId: "owner-1" };
    const h1 = computeRequestFingerprint(p1);
    // Shape-check on at least one side — a stub returning a constant (e.g. "")
    // would pass a mutual-equality-only assertion; pin the real hex64 shape too.
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(computeRequestFingerprint(p2));
  });

  it("excludes idempotencyKey from the hash (B6 — acceptance row 3)", () => {
    const p1 = { ownerPartyId: "owner-1", amount: "150.00", idempotencyKey: "key-aaa" };
    const p2 = { ownerPartyId: "owner-1", amount: "150.00", idempotencyKey: "key-bbb" };
    const h1 = computeRequestFingerprint(p1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(computeRequestFingerprint(p2));
    // Negative control: the SAME two payloads' fingerprint must differ from a
    // fingerprint computed with idempotencyKey INCLUDED (i.e. differ from hashing
    // canonicalJSON(p1) directly) — proves exclusion actually strips the field
    // rather than the field coincidentally not affecting canonicalJSON's output.
    const rawHashWithKey = createHash("sha256").update(canonicalJSON(p1)).digest("hex");
    expect(h1).not.toBe(rawHashWithKey);
  });

  it("changes when a real field (amount) changes (B8 — acceptance row 2)", () => {
    const p1 = { ownerPartyId: "owner-1", amount: "150.00" };
    const p2 = { ownerPartyId: "owner-1", amount: "150.01" };
    expect(computeRequestFingerprint(p1)).not.toBe(computeRequestFingerprint(p2));
  });

  it("is stable for a nested payload with keys reordered at every level (B7 — determinism note)", () => {
    const p1 = {
      ownerPartyId: "owner-1",
      amount: "300.00",
      allocations: [
        { ownerStatementPeriodId: "period-1", allocatedAmount: "200.00" },
        { ownerStatementPeriodId: "period-2", allocatedAmount: "100.00" },
      ],
      idempotencyKey: "key-aaa",
    };
    // Same logical payload: top-level keys reordered, AND each allocation object's
    // own keys reordered, AND idempotencyKey value changed. Array element order
    // (period-1 before period-2) is preserved — only key order + idempotencyKey differ.
    const p2 = {
      idempotencyKey: "key-different",
      allocations: [
        { allocatedAmount: "200.00", ownerStatementPeriodId: "period-1" },
        { allocatedAmount: "100.00", ownerStatementPeriodId: "period-2" },
      ],
      amount: "300.00",
      ownerPartyId: "owner-1",
    };
    const h1 = computeRequestFingerprint(p1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(computeRequestFingerprint(p2));
  });

  it("does not crash on a top-level array payload (no 'idempotencyKey field' concept applies)", () => {
    // payload: unknown admits any shape; the 4 request schemas never produce a top-level
    // array, but the function must not throw if handed one (defensive — self-review B17a).
    expect(() => computeRequestFingerprint([1, 2, { idempotencyKey: "x" }])).not.toThrow();
    const h1 = computeRequestFingerprint([1, 2, 3]);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Array order is significant end-to-end (canonicalJSON's own rule) — no exclusion
    // logic applies to array elements even if one happens to be an object with that key.
    expect(computeRequestFingerprint([1, 2, 3])).not.toBe(computeRequestFingerprint([3, 2, 1]));
  });

  it("does not crash on a bare string/number/boolean top-level payload (adversarial-audit B23)", () => {
    expect(() => computeRequestFingerprint("just a string")).not.toThrow();
    expect(() => computeRequestFingerprint(42)).not.toThrow();
    expect(() => computeRequestFingerprint(true)).not.toThrow();
    expect(computeRequestFingerprint("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("remittanceCreateSchema", () => {
  it("accepts a well-formed OWNER_REMITTANCE payload (B12)", () => {
    const r = remittanceCreateSchema.safeParse(validRemittanceCreate());
    expect(r.success).toBe(true);
  });

  it("rejects amount:'0' (B9)", () => {
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), amount: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects a negative amount (B10)", () => {
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), amount: "-5.00" });
    expect(r.success).toBe(false);
  });

  it("rejects an amount with 3+ decimal places (B13)", () => {
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), amount: "10.123" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty allocations array for OWNER_REMITTANCE (B11)", () => {
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), allocations: [] });
    expect(r.success).toBe(false);
  });

  it("rejects an effectiveDate that is not a real calendar date (self-review hardening)", () => {
    // Shape-only regex would accept "2026-02-30" (Feb has 28/29 days) — a real calendar
    // date check catches it before it reaches the @db.Date column downstream (Task 5).
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), effectiveDate: "2026-02-30" });
    expect(r.success).toBe(false);
  });

  it("caps allocations at 50 entries, matching the sibling money-mutation convention (adversarial-audit B34)", () => {
    // billing.ts's allocatePaymentBatchSchema / recordAndAllocatePaymentSchema /
    // recordInvoicePaymentSchema all use .min(1).max(50) for their allocation arrays —
    // this schema is the same "atomic record+allocate" shape and should match.
    const many = Array.from({ length: 51 }, () => ({
      ownerStatementPeriodId: PERIOD_ID,
      allocatedAmount: "1.00",
    }));
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), allocations: many });
    expect(r.success).toBe(false);
  });

  it("caps memo/bankReference/proofKey at 500 chars, matching owner-ledger.ts's free-text convention (adversarial-audit B37)", () => {
    const tooLong = "x".repeat(501);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), memo: tooLong }).success).toBe(false);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), bankReference: tooLong }).success).toBe(
      false,
    );
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), proofKey: tooLong }).success).toBe(false);
  });

  it("rejects an empty-string bankReference/proofKey/memo but accepts a real value (adversarial-audit B29)", () => {
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), memo: "" }).success).toBe(false);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), bankReference: "" }).success).toBe(false);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), proofKey: "" }).success).toBe(false);
    const withValues = remittanceCreateSchema.safeParse({
      ...validRemittanceCreate(),
      memo: "owner requested early payout",
      bankReference: "REF-12345",
      proofKey: "uploads/proof-1.pdf",
    });
    expect(withValues.success).toBe(true);
  });

  it("rejects amount shapes the anchored regex is designed to gate (adversarial-audit B24)", () => {
    const rejects = [".5", "5.", "5.000", "1e10", " 5.00", "5.00 ", "+5.00"];
    for (const amount of rejects) {
      expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), amount }).success, amount).toBe(false);
    }
  });

  it("accepts a whole-number amount and a 1-decimal-place amount (adversarial-audit B24)", () => {
    // Established house convention (owner-billing.ts / owner-ledger.ts decimalString):
    // "at most 2dp", not "exactly 2dp" — 0 or 1 decimal digits are both valid.
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), amount: "150" }).success).toBe(true);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), amount: "150.5" }).success).toBe(true);
  });

  it("rejects an out-of-enum currency (adversarial-audit B26)", () => {
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), currency: "EUR" }).success).toBe(false);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), currency: "myr" }).success).toBe(false);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), currency: "" }).success).toBe(false);
  });

  it("rejects settlementKind:'OWNER_RECEIVABLE_OFFSET' — a real sibling enum value, but not valid HERE (adversarial-audit B27)", () => {
    const r = remittanceCreateSchema.safeParse({
      ...validRemittanceCreate(),
      settlementKind: "OWNER_RECEIVABLE_OFFSET",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a paymentMethod from the broader shared PAYMENT_METHODS enum that doesn't apply here (adversarial-audit B28)", () => {
    // REMITTANCE_PAYMENT_METHODS deliberately excludes fpx/card/credit_note (comment on
    // the export) — prove at least one excluded value is actually rejected, not just
    // documented as excluded.
    const r = remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), paymentMethod: "fpx" });
    expect(r.success).toBe(false);
  });

  it("rejects a payload missing any single required field (adversarial-audit B30)", () => {
    const required = ["ownerPartyId", "effectiveDate", "settlementKind", "currency", "idempotencyKey"] as const;
    for (const field of required) {
      const payload = { ...validRemittanceCreate() } as Record<string, unknown>;
      delete payload[field];
      expect(remittanceCreateSchema.safeParse(payload).success, field).toBe(false);
    }
  });

  it("rejects a full ISO datetime or wrong-separator effectiveDate (adversarial-audit B31)", () => {
    expect(
      remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), effectiveDate: "2026-07-20T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), effectiveDate: "2026/07/20" }).success).toBe(
      false,
    );
  });

  it("rejects a malformed/non-v4 ownerPartyId (adversarial-audit B32)", () => {
    expect(remittanceCreateSchema.safeParse({ ...validRemittanceCreate(), ownerPartyId: "not-a-uuid" }).success).toBe(
      false,
    );
    // Well-formed UUID SHAPE but not v4 (third group doesn't start "4") — Zod v4's .uuid()
    // enforces the bit pattern, per this file's own header-comment gotcha (lines 9-11).
    expect(
      remittanceCreateSchema.safeParse({
        ...validRemittanceCreate(),
        ownerPartyId: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(false);
  });

  it("validates nested allocations[].allocatedAmount with the SAME strict positive-decimal rule as top-level amount (adversarial-audit B35)", () => {
    const r = remittanceCreateSchema.safeParse({
      ...validRemittanceCreate(),
      allocations: [{ ownerStatementPeriodId: PERIOD_ID, allocatedAmount: "0" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("remittanceAllocateSchema", () => {
  it("accepts a valid non-empty allocations payload (B14 happy)", () => {
    const r = remittanceAllocateSchema.safeParse({
      allocations: [{ ownerStatementPeriodId: PERIOD_ID, allocatedAmount: "200.00" }],
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an empty allocations array (B14 error)", () => {
    const r = remittanceAllocateSchema.safeParse({
      allocations: [],
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a missing idempotencyKey (B14 error)", () => {
    const r = remittanceAllocateSchema.safeParse({
      allocations: [{ ownerStatementPeriodId: PERIOD_ID, allocatedAmount: "200.00" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("offsetCreateSchema", () => {
  const validOffsetCreate = () => ({
    ownerPartyId: OWNER_ID,
    effectiveDate: "2026-07-20",
    currency: "MYR" as const,
    lineAllocations: [{ billingDocumentLineId: LINE_ID, allocatedAmount: "60.00" }],
    idempotencyKey: "00000000-0000-4000-8000-000000000099",
  });

  it("accepts a valid non-empty lineAllocations payload (B15 happy)", () => {
    const r = offsetCreateSchema.safeParse(validOffsetCreate());
    expect(r.success).toBe(true);
  });

  it("rejects an empty lineAllocations array (B15 error)", () => {
    const r = offsetCreateSchema.safeParse({ ...validOffsetCreate(), lineAllocations: [] });
    expect(r.success).toBe(false);
  });

  it("has no top-level amount field — total is derived server-side from Σ lineAllocations", () => {
    // Mirrors recordAndAllocatePaymentSchema's convention (billing.ts:229-231): the total
    // is Σ(allocations), never a client-supplied top-level amount, so it always foots.
    const r = offsetCreateSchema.safeParse({ ...validOffsetCreate(), amount: "9999.00" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).amount).toBeUndefined();
    }
  });

  it("rejects an out-of-enum currency (adversarial-audit B26)", () => {
    expect(offsetCreateSchema.safeParse({ ...validOffsetCreate(), currency: "EUR" }).success).toBe(false);
  });

  it("rejects a payload missing any single required field (adversarial-audit B30)", () => {
    const required = ["ownerPartyId", "effectiveDate", "currency", "idempotencyKey"] as const;
    for (const field of required) {
      const payload = { ...validOffsetCreate() } as Record<string, unknown>;
      delete payload[field];
      expect(offsetCreateSchema.safeParse(payload).success, field).toBe(false);
    }
  });

  it("rejects a malformed billingDocumentLineId (adversarial-audit B32)", () => {
    const r = offsetCreateSchema.safeParse({
      ...validOffsetCreate(),
      lineAllocations: [{ billingDocumentLineId: "not-a-uuid", allocatedAmount: "60.00" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("reverseSchema", () => {
  // Shared by both POST /owner-remittances/:id/reverse and
  // POST /owner-receivable-offsets/:id/reverse (Task 9) — entryId comes from the URL.
  it("accepts a valid {reason, idempotencyKey} payload (B16 happy)", () => {
    const r = reverseSchema.safeParse({
      reason: "owner requested a correction",
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing reason (B16 error)", () => {
    const r = reverseSchema.safeParse({ idempotencyKey: "00000000-0000-4000-8000-000000000099" });
    expect(r.success).toBe(false);
  });

  it("rejects a too-short reason (B16 error)", () => {
    const r = reverseSchema.safeParse({
      reason: "ab",
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a missing idempotencyKey (B16 error)", () => {
    const r = reverseSchema.safeParse({ reason: "owner requested a correction" });
    expect(r.success).toBe(false);
  });

  it("accepts a reason at exactly the 3-char minimum (adversarial-audit B36 — accept-boundary)", () => {
    // B16's reject-boundary test uses "ab" (2 chars); the accept-boundary at exactly 3
    // was never independently pinned, so .min(3) vs an accidental .min(4) both passed
    // every existing test.
    const r = reverseSchema.safeParse({
      reason: "abc",
      idempotencyKey: "00000000-0000-4000-8000-000000000099",
    });
    expect(r.success).toBe(true);
  });
});
