import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseTranscript, inferRoleFromMeta, isoToEpochMs } from "./transcript.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "parser");
const read = (f) => readFileSync(join(FIX, f), "utf8");
const readMeta = (f) => JSON.parse(read(f));

test("clean impl: timestamps, tokens (incl cached), one matched tool call, inferred stage", () => {
  const s = parseTranscript({ jsonlText: read("clean-impl.jsonl"), meta: readMeta("clean-impl.meta.json"), spanId: "s1" });
  assert.equal(s.startedAtEpochMs, isoToEpochMs("2026-07-13T16:00:00.000Z"));
  assert.equal(s.endedAtEpochMs, isoToEpochMs("2026-07-13T16:00:20.000Z"));
  assert.equal(s.inputTokens, 1500);
  assert.equal(s.outputTokens, 130);
  assert.equal(s.cacheReadTokens, 500);       // cached-token field captured
  assert.equal(s.cacheCreationTokens, 100);
  assert.equal(s.model, "claude-opus-4-8");
  assert.equal(s.toolCalls, 1);
  assert.equal(s.summedToolMs, 3000);         // 16:00:10 -> 16:00:13
  assert.equal(s.unionElapsedToolMs, 3000);
  assert.equal(s.unmatchedToolUses, 0);
  assert.equal(s.unmatchedToolResults, 0);
  assert.equal(s.stage, "implement");
  assert.equal(s.taskId, "task-1");
  assert.equal(s.stageClass, "inferred");
  assert.equal(s.stageConfidence, "medium");
  assert.deepEqual(s.dataQuality.errors, []);
  assert.equal(s.baseCommit, null);           // §2 unknown historically
  assert.equal(s.baseHeadClass, "unknown");
});

test("messy: malformed line skipped, interrupted tool call + orphan result flagged", () => {
  const s = parseTranscript({ jsonlText: read("messy.jsonl"), meta: readMeta("messy.meta.json"), spanId: "s2" });
  assert.equal(s.dataQuality.malformedLines, 1);
  assert.ok(s.dataQuality.errors.some((e) => /malformed/i.test(e)));
  assert.equal(s.toolCalls, 2);               // a + b
  assert.equal(s.summedToolMs, 2000);         // only "a" matched (16:10:00 -> 16:10:02)
  assert.equal(s.unionElapsedToolMs, 2000);
  assert.equal(s.unmatchedToolUses, 1);       // "b" interrupted
  assert.equal(s.unmatchedToolResults, 1);    // "zzz" orphan
  assert.ok(s.dataQuality.errors.some((e) => /interrupted/i.test(e)));
  assert.ok(s.dataQuality.errors.some((e) => /no matching call/i.test(e)));
  assert.equal(s.stage, "review-adversarial"); // from name label task7-adv
  assert.equal(s.taskId, "task-7");
  assert.equal(s.inputTokens, 150);
});

test("no reliable timestamp + missing meta: nulls + flags, stage unknown (not forced)", () => {
  const s = parseTranscript({ jsonlText: read("no-timestamps.jsonl"), meta: null, spanId: "s3" });
  assert.equal(s.startedAtEpochMs, null);
  assert.equal(s.endedAtEpochMs, null);
  assert.ok(s.dataQuality.missingFields.some((m) => m.field === "startedAtEpochMs"));
  assert.equal(s.stage, "unknown");
  assert.equal(s.stageClass, "unknown");
  assert.equal(s.inputTokens, 10);
});

// ---- conservative label inference (§5) ----
test("inferRoleFromMeta: exact patterns inferred with confidence + explanation", () => {
  assert.deepEqual(pick(inferRoleFromMeta({ description: "Standard review Task 3" })),
    { stage: "review-standard", taskId: "task-3", confidence: "medium" });
  assert.deepEqual(pick(inferRoleFromMeta({ name: "final-integ", agentType: "general-purpose" })),
    { stage: "integration-gate", taskId: null, confidence: "medium" });
});

test("inferRoleFromMeta: ambiguous/unmatched -> unknown, never force-placed", () => {
  const r = inferRoleFromMeta({ agentType: "general-purpose", description: "Investigate the flaky suite" });
  assert.equal(r.stage, "unknown");
  assert.equal(r.taskId, null);
  assert.equal(r.confidence, null);
  assert.ok(/not matched/i.test(r.note));
});

test("inferRoleFromMeta: null meta -> unknown with explanation", () => {
  const r = inferRoleFromMeta(null);
  assert.equal(r.stage, "unknown");
  assert.ok(/no meta/i.test(r.note));
});

test("inferRoleFromMeta: weak generic 'review' -> review-ambiguous at low confidence", () => {
  const r = inferRoleFromMeta({ agentType: "general-purpose", description: "Review Task 2 changes" });
  assert.equal(r.stage, "review-ambiguous");
  assert.equal(r.taskId, "task-2");
  assert.equal(r.confidence, "low");
  // explicit standard/adversarial still take precedence over the generic branch
  assert.equal(inferRoleFromMeta({ description: "Adversarial review Task 2" }).stage, "review-adversarial");
});

test("inferRoleFromMeta: never emits outcome/findings from prose (only stage/task/role keys)", () => {
  const r = inferRoleFromMeta({ description: "Adversarial review Task 1 — found a high rounding bug" });
  assert.deepEqual(Object.keys(r).sort(), ["agentRole", "confidence", "note", "stage", "taskId"]);
  assert.equal(r.stage, "review-adversarial"); // the prose 'found a bug' is ignored, not turned into a finding
});

function pick(r) { return { stage: r.stage, taskId: r.taskId, confidence: r.confidence }; }
