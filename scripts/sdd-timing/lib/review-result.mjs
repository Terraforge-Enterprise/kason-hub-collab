// Observational SDD timing — structured ReviewResult schema + validator + helper.
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md §1.
//
// AUTHORITY BOUNDARY (load-bearing):
//   - A ReviewResult is the REVIEWER's surface. It carries CLAIMS only:
//     reviewerClaimedNewlyDiscovered, duplicateOfFindingId, relatedFindingIds, outcome.
//   - It MUST NOT carry controller conclusions. `reworkOfFindingIds` is CONTROLLER/
//     fix-stage-owned and is REJECTED here; it lives in a separate ReworkLink surface.
//   - Authoritative relationships (adversarial-unique, final-caught-what-others-missed,
//     caused-rework) are produced LATER by controller reconciliation, never here.
// This module writes/reads/validates artifacts. It never parses free-form prose and
// never changes a reviewer's actual outcome if instrumentation fails.

import { readFileSync, writeFileSync, existsSync, mkdirSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const REVIEW_RESULT_SCHEMA_VERSION = "1.0.0";
export const REWORK_LINK_SCHEMA_VERSION = "1.0.0";
export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const REVIEW_OUTCOMES = ["clean", "changes-requested", "error"];
export const REVIEWER_ROLES = ["standard", "adversarial", "re-review", "final"];
export const CATEGORIES = [
  "correctness", "money", "security", "auth", "migration-safety",
  "concurrency", "performance", "test-coverage", "style", "other",
];

// Identifier safety: runId/taskId/reviewSpanId NAME FILES, so they must be
// filesystem-safe (no "/", no "..", no control chars, bounded length).
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
export const isSafeId = (v) => typeof v === "string" && SAFE_ID.test(v) && v !== "." && v !== "..";

// FINDING IDENTITY SCOPE: `findingId` is REVIEW-LOCAL — unique only within one
// ReviewResult (reviewer-chosen). It is NOT globally authoritative. The globally
// collision-safe identity used by future controller reconciliation is the composite
// below; a bare findingId must never be treated as globally unique.
export const compositeFindingId = (runId, reviewSpanId, findingId) => `${runId}::${reviewSpanId}::${findingId}`;

// CANONICAL HASH INPUTS (artifactId): the sha256 covers ALL semantic identity —
// schemaVersion, instrumentationVersion, runId, taskId, reviewSpanId, reviewerRole,
// reviewedBaseCommit, reviewedHeadCommit, outcome, and findings — and EXCLUDES only the
// volatile `generatedAtEpochMs` and `artifactId` itself. artifactId is always RECOMPUTED
// and VERIFIED by the helper; a caller-supplied artifactId is never trusted.

const ALLOWED_TOP = new Set([
  "schemaVersion", "instrumentationVersion", "runId", "taskId", "reviewSpanId", "reviewerRole",
  "reviewedBaseCommit", "reviewedHeadCommit", "generatedAtEpochMs", "artifactId", "findings", "outcome", "dataQuality",
]);
const ALLOWED_FINDING = new Set([
  "findingId", "reviewSpanId", "severity", "category", "summary", "file", "line",
  "reviewerClaimedNewlyDiscovered", "duplicateOfFindingId", "relatedFindingIds",
]);
// exported so the schema/validator parity test can prove the JSON Schema property set
// and the runtime allowed-field set do not silently diverge.
export const REVIEW_RESULT_TOP_KEYS = [...ALLOWED_TOP];
export const FINDING_KEYS = [...ALLOWED_FINDING];

// ---- canonicalization (deterministic; excludes volatile fields) ----
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const withoutVolatile = (a) => { const { generatedAtEpochMs, ...rest } = a; return rest; };
const contentHash = (a) => { const { artifactId, generatedAtEpochMs, ...rest } = a; return createHash("sha256").update(stableStringify(rest)).digest("hex"); };
const canonicalEqual = (a, b) => stableStringify(withoutVolatile(a)) === stableStringify(withoutVolatile(b));

/**
 * Validate a ReviewResult. strict (default) rejects unknown fields.
 * Returns { valid, errors, warnings, unresolvedReferences }. Unresolved cross-references
 * (to findings not present locally) are NOT errors — they may belong to an earlier review
 * and are preserved for controller reconciliation.
 */
export function validateReviewResult(obj, { strict = true } = {}) {
  const errors = [];
  const warnings = [];
  const unresolvedReferences = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not an object"], warnings, unresolvedReferences };

  if (obj.schemaVersion !== REVIEW_RESULT_SCHEMA_VERSION) errors.push(`unknown/unsupported schemaVersion: ${obj.schemaVersion}`);
  for (const req of ["instrumentationVersion", "runId", "taskId", "reviewSpanId", "reviewerRole", "generatedAtEpochMs", "artifactId", "outcome"]) {
    if (obj[req] == null) errors.push(`missing required field: ${req}`);
  }
  if (obj.reviewerRole != null && !REVIEWER_ROLES.includes(obj.reviewerRole)) errors.push(`invalid reviewerRole: ${obj.reviewerRole}`);
  if (obj.outcome != null && !REVIEW_OUTCOMES.includes(obj.outcome)) errors.push(`invalid outcome enum: ${obj.outcome}`);
  // identifiers that name files must be filesystem-safe (path-traversal defence)
  for (const idf of ["runId", "taskId", "reviewSpanId"]) if (obj[idf] != null && !isSafeId(obj[idf])) errors.push(`unsafe ${idf} (must be [A-Za-z0-9._-]{1,128}, not "." or ".."): ${JSON.stringify(obj[idf])}`);
  // commit ranges optional; if present must be strings — never inferred
  for (const c of ["reviewedBaseCommit", "reviewedHeadCommit"]) if (obj[c] != null && typeof obj[c] !== "string") errors.push(`${c} must be a string or null`);
  if (strict) for (const k of Object.keys(obj)) if (!ALLOWED_TOP.has(k)) errors.push(`unknown top-level field: ${k}`);
  // controller-owned field must never appear on the reviewer surface
  if ("reworkOfFindingIds" in obj) errors.push("reworkOfFindingIds is controller-owned; not permitted in a ReviewResult");
  // artifactId is recomputed & VERIFIED from canonical content — never trusted from caller input
  if (obj.artifactId != null) {
    const expected = contentHash(obj);
    if (obj.artifactId !== expected) errors.push(`artifactId does not match canonical content hash (expected ${expected})`);
  }

  const findings = Array.isArray(obj.findings) ? obj.findings : null;
  if (findings == null) errors.push("findings must be an array");

  const idSet = new Set();
  const byId = new Map();
  if (findings) {
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      const at = `findings[${i}]`;
      if (!f || typeof f !== "object" || Array.isArray(f)) { errors.push(`${at}: not an object`); continue; }
      if ("reworkOfFindingIds" in f) errors.push(`${at}: reworkOfFindingIds is controller-owned; not permitted`);
      if (strict) for (const k of Object.keys(f)) if (!ALLOWED_FINDING.has(k)) errors.push(`${at}: unknown field: ${k}`);
      for (const req of ["findingId", "severity", "category"]) if (f[req] == null) errors.push(`${at}: missing required field: ${req}`);
      if (f.severity != null && !SEVERITIES.includes(f.severity)) errors.push(`${at}: invalid severity enum: ${f.severity}`);
      if (f.category != null && !CATEGORIES.includes(f.category)) errors.push(`${at}: invalid category enum: ${f.category}`);
      if (f.reviewerClaimedNewlyDiscovered != null && typeof f.reviewerClaimedNewlyDiscovered !== "boolean") errors.push(`${at}: reviewerClaimedNewlyDiscovered must be boolean`);
      // a finding claiming a different review is provenance corruption (establishable)
      if (f.reviewSpanId != null && obj.reviewSpanId != null && f.reviewSpanId !== obj.reviewSpanId) errors.push(`${at}: findingId ${f.findingId} belongs to another review (reviewSpanId ${f.reviewSpanId} != ${obj.reviewSpanId})`);
      if (f.findingId != null) {
        if (idSet.has(f.findingId)) errors.push(`${at}: duplicate findingId: ${f.findingId}`);
        idSet.add(f.findingId);
        byId.set(f.findingId, f);
      }
      if (f.duplicateOfFindingId != null && f.duplicateOfFindingId === f.findingId) errors.push(`${at}: self-referencing duplicateOfFindingId`);
      if (f.relatedFindingIds != null) {
        if (!Array.isArray(f.relatedFindingIds)) errors.push(`${at}: relatedFindingIds must be an array`);
        else {
          if (f.relatedFindingIds.includes(f.findingId)) errors.push(`${at}: relatedFindingIds self-reference`);
          if (new Set(f.relatedFindingIds).size !== f.relatedFindingIds.length) errors.push(`${at}: duplicate relatedFindingIds`);
        }
      }
    }
    // reference resolution + contradiction detection (second pass)
    for (const f of findings) {
      if (!f || typeof f !== "object") continue;
      if (f.duplicateOfFindingId != null && f.duplicateOfFindingId !== f.findingId) {
        if (!idSet.has(f.duplicateOfFindingId)) unresolvedReferences.push({ kind: "duplicateOf", from: f.findingId, ref: f.duplicateOfFindingId });
        else {
          const other = byId.get(f.duplicateOfFindingId);
          if (other && other.duplicateOfFindingId === f.findingId) errors.push(`contradictory mutual duplication: ${f.findingId} <-> ${other.findingId}`);
        }
      }
      if (Array.isArray(f.relatedFindingIds)) for (const r of f.relatedFindingIds) if (r !== f.findingId && !idSet.has(r)) unresolvedReferences.push({ kind: "related", from: f.findingId, ref: r });
    }
  }
  // cross-field semantic consistency (based on the outcome enum)
  if (findings) {
    const blocking = findings.filter((f) => f && (f.severity === "critical" || f.severity === "high"));
    if (obj.outcome === "clean" && blocking.length > 0) errors.push(`outcome 'clean' contradicts ${blocking.length} blocking finding(s) (critical/high)`);
    if (obj.outcome === "changes-requested" && findings.length === 0) errors.push("outcome 'changes-requested' must identify at least one finding");
    for (const f of findings) if (f && f.duplicateOfFindingId != null && f.reviewerClaimedNewlyDiscovered === true) errors.push(`findings: ${f.findingId} marked duplicate yet reviewerClaimedNewlyDiscovered=true (incompatible)`);
  }
  // de-dup the contradiction message (A<->B seen from both sides)
  const dedupErrors = [...new Set(errors)];
  return { valid: dedupErrors.length === 0, errors: dedupErrors, warnings, unresolvedReferences };
}

function normalizeFinding(reviewSpanId, f) {
  return {
    findingId: f.findingId,
    reviewSpanId: f.reviewSpanId ?? reviewSpanId, // explicit provenance
    severity: f.severity,
    category: f.category,
    summary: f.summary ?? null,
    file: f.file ?? null,
    line: f.line ?? null,
    reviewerClaimedNewlyDiscovered: f.reviewerClaimedNewlyDiscovered ?? null, // a CLAIM (or unknown); never forced
    duplicateOfFindingId: f.duplicateOfFindingId ?? null,
    relatedFindingIds: Array.isArray(f.relatedFindingIds) ? [...f.relatedFindingIds] : [],
  };
}

/** Build a ReviewResult artifact. artifactId is a content hash (excl volatile fields) so
 * a retry with identical content produces an identical id. Never infers commit ranges. */
export function buildReviewResult(input, { now, instrumentationVersion = "sdd-timing/1.0.0" } = {}) {
  const generatedAtEpochMs = typeof now === "function" ? now() : (typeof now === "number" ? now : Date.now());
  const base = {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    instrumentationVersion,
    runId: input.runId,
    taskId: input.taskId,
    reviewSpanId: input.reviewSpanId,
    reviewerRole: input.reviewerRole,
    reviewedBaseCommit: input.reviewedBaseCommit ?? null,
    reviewedHeadCommit: input.reviewedHeadCommit ?? null,
    generatedAtEpochMs,
    findings: (input.findings ?? []).map((f) => normalizeFinding(input.reviewSpanId, f)),
    outcome: input.outcome,
  };
  return { ...base, artifactId: contentHash(base) };
}

/** Validate then atomically publish to review-<reviewSpanId>.json. Never leaves a partial
 * artifact; refuses to overwrite a differing artifact; idempotent for identical content. */
export function writeReviewResult(dir, artifact, { strict = true } = {}) {
  const validation = validateReviewResult(artifact, { strict });
  if (!validation.valid) return { ok: false, reason: "invalid", errors: validation.errors, unresolvedReferences: validation.unresolvedReferences };
  // defence-in-depth: never touch the fs with an unsafe path even if validation changed
  if (!isSafeId(artifact.reviewSpanId)) return { ok: false, reason: "unsafe-id", error: `unsafe reviewSpanId: ${JSON.stringify(artifact.reviewSpanId)}` };
  const path = join(dir, `review-${artifact.reviewSpanId}.json`);
  const serialized = JSON.stringify(artifact, null, 2) + "\n";
  let tmp = null;
  try {
    mkdirSync(dir, { recursive: true });
    tmp = join(dir, `.review-${artifact.reviewSpanId}.${randomUUID()}.tmp`);
    writeFileSync(tmp, serialized);               // fully written to a private temp first (never partial at `path`)
    try {
      // ATOMIC no-clobber publish: link() fails with EEXIST if `path` already exists.
      // Unlike rename(), it never silently replaces a concurrent writer's artifact.
      linkSync(tmp, path);
      return { ok: true, path };
    } catch (e) {
      if (e && e.code === "EEXIST") {
        let existingObj;
        try { existingObj = JSON.parse(readFileSync(path, "utf8")); }
        catch { return { ok: false, reason: "existing-corrupted", path }; }
        if (canonicalEqual(existingObj, artifact)) return { ok: true, idempotent: true, path }; // identical retry
        return { ok: false, reason: "conflict", error: "refusing to overwrite a differing artifact", path };
      }
      throw e;
    }
  } catch (e) {
    return { ok: false, reason: "io-error", error: String((e && e.message) || e), path };
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* best-effort temp cleanup */ } }
  }
}

export function readReviewResult(dir, reviewSpanId, { strict = true } = {}) {
  const path = join(dir, `review-${reviewSpanId}.json`);
  if (!existsSync(path)) return { ok: false, reason: "missing", path };
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (e) { return { ok: false, reason: "io-error", error: String((e && e.message) || e), path }; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return { ok: false, reason: "corrupted-json", path }; }
  const validation = validateReviewResult(obj, { strict });
  return { ok: validation.valid, reason: validation.valid ? null : "invalid", artifact: obj, validation, path };
}

// ---- ReworkLink: the SEPARATE controller-owned surface (keeps rework ownership out of ReviewResult) ----
const ALLOWED_REWORK = new Set(["schemaVersion", "instrumentationVersion", "runId", "taskId", "fixSpanId", "reworkOfFindingIds", "generatedAtEpochMs", "artifactId"]);
export function validateReworkLink(obj, { strict = true } = {}) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, errors: ["not an object"] };
  if (obj.schemaVersion !== REWORK_LINK_SCHEMA_VERSION) errors.push(`unknown/unsupported schemaVersion: ${obj.schemaVersion}`);
  for (const req of ["runId", "taskId", "fixSpanId", "reworkOfFindingIds", "generatedAtEpochMs", "artifactId"]) if (obj[req] == null) errors.push(`missing required field: ${req}`);
  if (!Array.isArray(obj.reworkOfFindingIds)) errors.push("reworkOfFindingIds must be an array of finding-id strings");
  else if (obj.reworkOfFindingIds.some((x) => typeof x !== "string")) errors.push("reworkOfFindingIds must contain only finding-id strings");
  if (strict) for (const k of Object.keys(obj)) if (!ALLOWED_REWORK.has(k)) errors.push(`unknown field: ${k}`);
  return { valid: errors.length === 0, errors };
}
