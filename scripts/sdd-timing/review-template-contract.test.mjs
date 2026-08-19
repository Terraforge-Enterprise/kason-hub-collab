// Presence/contract test for the ADDITIVE ReviewResult-telemetry step mirrored into the
// Kason-Hub copy of the SDD reviewer templates. Asserts the contract phrases are present
// AND that the pre-existing semantic-review instructions are still there (proving the change
// is additive, not a rewrite). Whitespace is normalised so line-wrapping doesn't matter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SDD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "Upgraded-Claude-Skills", "skills", "subagent-driven-development");
const norm = (p) => readFileSync(join(SDD, p), "utf8").replace(/\s+/g, " ");
const STD = norm("reviewer-prompt.md");
const ADV = norm("adversarial-reviewer-prompt.md");

// Shared additive contract — present in BOTH templates
const SHARED = [
  "[SDD_INSTRUMENTATION_CONTEXT]",
  "runs LAST, after the review is final",
  "print NO warning, and invent no instrumentation values",           // no-context = silent
  "attempt EXACTLY ONE ReviewResult publication",                     // exactly one
  "DERIVED FROM the review you just finalised (never a second review)", // not a second review
  "Do NOT import the library, use `node -e`, or invent an invocation", // concrete interface only
  "Do NOT infer cross-review uniqueness, rework causation",           // no controller conclusions
  "Leave reviewerClaimedNewlyDiscovered null",                        // novelty stays unknown
  "only telemetry is incomplete",                                     // failure warning wording
  "The semantic review above stands",
];

test("both reviewer templates carry the additive telemetry contract", () => {
  for (const phrase of SHARED) {
    assert.ok(STD.includes(phrase), `standard template missing: ${phrase}`);
    assert.ok(ADV.includes(phrase), `adversarial template missing: ${phrase}`);
  }
});

test("no-context condition is SILENT (no warning, no attempt, no fabrication)", () => {
  for (const t of [STD, ADV]) {
    assert.ok(t.includes("absence is a NORMAL condition"));
    assert.ok(t.includes("print NO warning, and invent no instrumentation values"));
  }
});

test("outcome mapping mirrors the prose verdict (per template)", () => {
  assert.ok(STD.includes('Approved -> "clean"'));
  assert.ok(STD.includes('Needs fixes -> "changes-requested"'));
  assert.ok(ADV.includes('NO EXPLOITABLE GAPS FOUND -> "clean"'));
  assert.ok(ADV.includes('GAPS FOUND -> "changes-requested"'));
});

test("adversarial: severity is IMPACT, never derived from CONFIRMED/PLAUSIBLE confidence", () => {
  assert.ok(ADV.includes("Each finding's severity is the IMPACT from your **Severity** column"));
  assert.ok(ADV.includes("it is NEVER derived from the CONFIRMED/PLAUSIBLE Label"));
  assert.ok(ADV.includes("Confidence is not severity"));
});

test("standard: severity uses the existing impact rubric (Critical/Important/Minor)", () => {
  assert.ok(STD.includes("Critical -> critical, Important -> high, Minor -> low"));
});

test("change is ADDITIVE: the pre-existing semantic-review instructions remain", () => {
  // standard reviewer keeps its full review body + verdict
  assert.ok(STD.includes("## Part 1: Spec Compliance"));
  assert.ok(STD.includes("## Part 2: Code Quality"));
  assert.ok(STD.includes("Task quality:** [Approved | Needs fixes]"));
  // adversarial keeps its failure-scenario method + verdict + label/severity columns
  assert.ok(ADV.includes("Verdict:** GAPS FOUND | NO EXPLOITABLE GAPS FOUND"));
  assert.ok(ADV.includes("state → input → wrong outcome") || ADV.includes("Failure scenario (state → input → wrong outcome)"));
  assert.ok(ADV.includes("CONFIRMED") && ADV.includes("PLAUSIBLE"));
});
