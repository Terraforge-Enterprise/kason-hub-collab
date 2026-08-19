// Phase-2 owner remittance / offset / reversal / idempotency — shared finance primitives.
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md
// (Task 4; Resolved design decision #1 = R25 idempotency fingerprint; GC2 integer cents;
// GC6 idempotency-with-fingerprint).
//
// Pure @kason/shared module: NO DB, NO API, NO money math here — the Zod request schemas
// live alongside in ../schemas/owner-remittance.ts. Integer-cents conversion happens at the
// Task-5 service boundary, not here (GC2) — amounts cross this layer as validated strings.

// Namespace import (not `{ createHash }`): keeps this Node-only builtin out of the
// browser bundle's named-binding graph. `@kason/shared`'s barrel re-exports this module,
// so a static named import of a Node builtin breaks the web (rollup) build with
// "createHash is not exported by __vite-browser-external". A namespace binding resolves
// cleanly and the server-only `computeRequestFingerprint` tree-shakes out of the SPA.
// Node behavior is byte-identical — `nodeCrypto.createHash` IS `crypto.createHash`.
import * as nodeCrypto from "node:crypto";

/**
 * Deterministic JSON serialization: object keys are sorted recursively (alphabetically,
 * by `Object.keys(...).sort()`, i.e. UTF-16 code-unit order) so two objects that are
 * semantically equal but constructed/received with keys in a different order serialize
 * to the IDENTICAL string. Array element order is preserved (arrays are order-sensitive —
 * `[1,2]` and `[2,1]` are NOT the same request). `undefined`-valued object properties are
 * dropped (mirrors `JSON.stringify`'s own behaviour for object properties, at every
 * nesting depth — not just the top level), so a field that was omitted and a field
 * explicitly set to `undefined` canonicalize identically. Primitives (string/number/
 * boolean) and `null` pass through `JSON.stringify` for correct escaping. This function
 * has NO knowledge of `idempotencyKey` — that exclusion is `computeRequestFingerprint`'s
 * job (see below), keeping this a reusable canonicalizer for any JSON-PLAIN value.
 *
 * SCOPE (adversarial-audit B21): "JSON-plain" means string/number/boolean/null/array/
 * plain-object ONLY — matching exactly what the 4 Zod schemas in ../schemas/owner-remittance.ts
 * ever produce as parsed output. Exotic JS values are NOT handled specially and are
 * explicitly out of scope: a `Date`/`Map`/`Set`/class instance has no own enumerable
 * string keys, so it collapses to the content-blind `"{}"`; a `function`/`Symbol` leaf
 * returns `JSON.stringify`'s `undefined` (violating the declared `string` return type);
 * a `bigint` leaf throws inside `JSON.stringify`. None of these can occur from a
 * Zod-parsed request body (money/dates are validated STRINGS, never native Date/bigint),
 * so this is a documented boundary, not a bug — do not widen this function to "handle"
 * exotic types without a concrete caller that needs it.
 */
export function canonicalJSON(v: unknown): string {
  if (v === null || v === undefined) return "null";

  if (Array.isArray(v)) {
    return "[" + v.map((el) => canonicalJSON(el)).join(",") + "]";
  }

  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
    return "{" + entries.join(",") + "}";
  }

  // string | number | boolean
  return JSON.stringify(v);
}

/**
 * R25 idempotency fingerprint: sha256 hex digest of the canonical payload, with the
 * TOP-LEVEL `idempotencyKey` field stripped before canonicalizing (so two requests
 * differing only in `idempotencyKey` fingerprint identically — GC6). Stored in
 * `OwnerLedgerEntry.requestFingerprint` (Task 5) and compared on replay: same
 * `(organizationId, settlementKind, idempotencyKey)` + same fingerprint → return the
 * prior success, write nothing; same key + a DIFFERENT fingerprint → `409
 * IDEMPOTENCY_KEY_REUSED`. Only the TOP level is stripped — `canonicalJSON` itself has
 * no knowledge of the field name and recurses uniformly, so a (currently nonexistent)
 * nested `idempotencyKey` inside a sub-object would NOT be stripped.
 *
 * TWO KNOWN, DELIBERATE sensitivities (adversarial-audit B38/B39) — both are direct,
 * intended consequences of `canonicalJSON` hashing the LITERAL payload, not a bug:
 *   1. Array order is significant (mandated — see canonicalJSON's docstring), so an
 *      `allocations`/`lineAllocations` array reconstructed in a different element order
 *      between an original call and its retry fingerprints differently, which would read
 *      as a false `409 IDEMPOTENCY_KEY_REUSED` rather than a clean replay.
 *   2. Money strings are hashed as literal text, not parsed value — "100.00" and "100.0"
 *      both mean 10000 cents but fingerprint differently. This module deliberately does
 *      NOT normalize amounts (it has no schema/field awareness by design); if either
 *      sensitivity proves to be a real operational problem, the fix belongs in the
 *      Task-5 service layer (sort allocations / round-trip amounts through
 *      `toCents`/`centsToString` BEFORE calling this), which — unlike this generic
 *      module — knows which fields are money/array-of-allocations.
 */
export function computeRequestFingerprint(payload: unknown): string {
  let target: unknown = payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    target = Object.fromEntries(
      Object.entries(payload as Record<string, unknown>).filter(([k]) => k !== "idempotencyKey"),
    );
  }
  return nodeCrypto.createHash("sha256").update(canonicalJSON(target)).digest("hex");
}
