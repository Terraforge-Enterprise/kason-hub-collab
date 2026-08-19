// Anti-drift guard between review-result.schema.json (JSON Schema) and the runtime validator.
// (1) constants parity: schema enums/const/keys MUST equal the runtime's exported constants —
//     so a future edit to one without the other fails this test rather than diverging silently.
// (2) corpus parity: a labelled corpus run through BOTH a minimal draft-07-subset checker and
//     the runtime validator. On the STRUCTURAL subset they agree; the runtime is a strict
//     SUPERSET for cross-field semantics that JSON Schema cannot express (documented per case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildReviewResult, validateReviewResult,
  SEVERITIES, CATEGORIES, REVIEW_OUTCOMES, REVIEWER_ROLES,
  REVIEW_RESULT_SCHEMA_VERSION, REVIEW_RESULT_TOP_KEYS, FINDING_KEYS,
} from "./review-result.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "review-result.schema.json"), "utf8"));

const GOLDEN_INPUT = {
  runId: "run-1", taskId: "task-7", reviewSpanId: "rev-adv-7", reviewerRole: "adversarial",
  reviewedBaseCommit: "aaa111", reviewedHeadCommit: "bbb222", outcome: "changes-requested",
  findings: [
    { findingId: "F1", severity: "high", category: "money", summary: "x", file: "a.ts", line: 1, reviewerClaimedNewlyDiscovered: true, duplicateOfFindingId: null, relatedFindingIds: [] },
    { findingId: "F2", severity: "low", category: "style", summary: "y", file: "b.ts", line: 2, reviewerClaimedNewlyDiscovered: false, duplicateOfFindingId: null, relatedFindingIds: [] },
  ],
};
const build = (over = {}) => buildReviewResult({ ...GOLDEN_INPUT, ...over }, { now: 1784500000000 });

// ---- (1) constants parity ----
test("schema/validator CONSTANTS parity (enums, const, keys)", () => {
  const rr = SCHEMA.definitions.reviewResult;
  const f = SCHEMA.definitions.finding;
  assert.deepEqual(f.properties.severity.enum, SEVERITIES);
  assert.deepEqual(f.properties.category.enum, CATEGORIES);
  assert.deepEqual(rr.properties.outcome.enum, REVIEW_OUTCOMES);
  assert.deepEqual(rr.properties.reviewerRole.enum, REVIEWER_ROLES);
  assert.equal(rr.properties.schemaVersion.const, REVIEW_RESULT_SCHEMA_VERSION);
  assert.equal(rr.additionalProperties, false);
  assert.equal(f.additionalProperties, false);
  assert.deepEqual(Object.keys(rr.properties).sort(), [...REVIEW_RESULT_TOP_KEYS].sort());
  assert.deepEqual(Object.keys(f.properties).sort(), [...FINDING_KEYS].sort());
});

// ---- minimal draft-07-subset checker (only the constructs our schema uses) ----
function typeOk(v, t) {
  return (Array.isArray(t) ? t : [t]).some((tt) =>
    tt === "null" ? v === null :
    tt === "string" ? typeof v === "string" :
    tt === "integer" ? Number.isInteger(v) :
    tt === "boolean" ? typeof v === "boolean" :
    tt === "array" ? Array.isArray(v) :
    tt === "object" ? (v && typeof v === "object" && !Array.isArray(v)) : true);
}
function check(value, node, root, path, errors) {
  if (node.$ref) return check(value, node.$ref.split("/").slice(1).reduce((o, k) => o[k], root), root, path, errors);
  if (node.oneOf) {
    const m = node.oneOf.filter((s) => check(value, s, root, path, []).length === 0);
    if (m.length !== 1) errors.push(`${path}: oneOf matched ${m.length}`);
    return errors;
  }
  if ("const" in node && value !== node.const) errors.push(`${path}: const`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: enum`);
  if (node.type && !typeOk(value, node.type)) { errors.push(`${path}: type`); return errors; }
  if (value && typeof value === "object" && !Array.isArray(value) && (node.properties || node.required || node.additionalProperties === false)) {
    for (const r of node.required || []) if (!(r in value)) errors.push(`${path}: required ${r}`);
    if (node.additionalProperties === false) for (const k of Object.keys(value)) if (!node.properties || !(k in node.properties)) errors.push(`${path}: additional ${k}`);
    for (const [k, sub] of Object.entries(node.properties || {})) if (k in value) check(value[k], sub, root, `${path}.${k}`, errors);
  }
  if (Array.isArray(value) && node.items) value.forEach((it, i) => check(it, node.items, root, `${path}[${i}]`, errors));
  return errors;
}
const schemaValid = (obj) => check(obj, SCHEMA, SCHEMA, "$", []).length === 0;

// ---- (2) corpus parity ----
const CORPUS = [
  { name: "valid golden", obj: build(), kind: "valid" },
  { name: "valid clean/empty", obj: build({ outcome: "clean", findings: [] }), kind: "valid" },
  // structural — BOTH must reject
  { name: "missing reviewSpanId", obj: (() => { const a = build(); delete a.reviewSpanId; return a; })(), kind: "structural-invalid" },
  { name: "bad severity enum", obj: build({ findings: [{ findingId: "A", severity: "X", category: "money", reviewerClaimedNewlyDiscovered: null, duplicateOfFindingId: null, relatedFindingIds: [] }] }), kind: "structural-invalid" },
  { name: "bad outcome enum", obj: build({ outcome: "approved" }), kind: "structural-invalid" },
  { name: "bad schemaVersion const", obj: (() => { const a = build(); a.schemaVersion = "9.9"; return a; })(), kind: "structural-invalid" },
  { name: "unknown top field", obj: (() => { const a = build(); a.mystery = 1; return a; })(), kind: "structural-invalid" },
  // semantic — schema ACCEPTS (structurally valid), runtime REJECTS (JSON Schema can't express these)
  { name: "duplicate findingId", obj: build({ findings: [{ findingId: "D", severity: "low", category: "style", reviewerClaimedNewlyDiscovered: null, duplicateOfFindingId: null, relatedFindingIds: [] }, { findingId: "D", severity: "low", category: "style", reviewerClaimedNewlyDiscovered: null, duplicateOfFindingId: null, relatedFindingIds: [] }] }), kind: "semantic-invalid" },
  { name: "clean + blocking finding", obj: build({ outcome: "clean" }), kind: "semantic-invalid" },
  { name: "changes-requested + empty", obj: build({ outcome: "changes-requested", findings: [] }), kind: "semantic-invalid" },
  { name: "tampered artifactId", obj: (() => { const a = build(); a.artifactId = "deadbeef"; return a; })(), kind: "semantic-invalid" },
  { name: "unsafe reviewSpanId", obj: build({ reviewSpanId: "../escape" }), kind: "semantic-invalid" },
];

test("schema/validator CORPUS parity (agree structurally; runtime is a semantic superset)", () => {
  for (const c of CORPUS) {
    const sOk = schemaValid(c.obj);
    const rOk = validateReviewResult(c.obj).valid;
    if (c.kind === "valid") { assert.equal(sOk, true, `[${c.name}] schema should accept`); assert.equal(rOk, true, `[${c.name}] runtime should accept`); }
    else if (c.kind === "structural-invalid") { assert.equal(sOk, false, `[${c.name}] schema should reject`); assert.equal(rOk, false, `[${c.name}] runtime should reject`); }
    else { assert.equal(sOk, true, `[${c.name}] schema accepts (structurally valid)`); assert.equal(rOk, false, `[${c.name}] runtime rejects (semantic)`); }
  }
});
