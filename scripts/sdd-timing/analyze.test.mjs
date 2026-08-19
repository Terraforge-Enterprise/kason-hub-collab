import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeRun, renderMarkdown } from "./analyze.mjs";
import { diffMetrics } from "./lib/gitmetrics.mjs";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-run");
const report = analyzeRun({ subagentsDir: GOLDEN, runId: "golden", provenance: "historical" });
const byStage = (st) => report.spans.find((s) => s.stage === st);

test("golden: span extraction (count, stage, task, duration, tokens)", () => {
  assert.equal(report.spanCount, 5);
  const impl = byStage("implement");
  assert.equal(impl.taskId, "task-1");
  assert.equal(impl.endedAtEpochMs - impl.startedAtEpochMs, 360000);
  assert.equal(impl.outputTokens, 100);
  assert.equal(impl.inputTokens, 1000);
  const adv = byStage("review-adversarial");
  assert.equal(adv.endedAtEpochMs - adv.startedAtEpochMs, 1200000);
  assert.equal(byStage("integration-gate").endedAtEpochMs - byStage("integration-gate").startedAtEpochMs, 300000);
});

test("golden: field provenance (stage inferred, base/head unknown)", () => {
  for (const s of report.spans) {
    assert.equal(s.stageClass, "inferred");
    assert.equal(s.baseHeadClass, "unknown");
    assert.equal(s.baseCommit, null);
    assert.equal(s.durationClock, "epoch");
  }
  assert.equal(byStage("implement").stageConfidence, "medium");
  assert.equal(byStage("fix").stageConfidence, "low"); // weak /\bfix\b/ match
});

test("golden: rollup values + HONEST status tags match hand calculation", () => {
  const R = report.rollup;
  // historical: envelope is INCOMPLETE (not authoritative wall-clock); no run boundaries observed
  assert.equal(R.observedSpanEnvelopeMs.value, 2400000);
  assert.equal(R.observedSpanEnvelopeMs.status, "incomplete");
  assert.equal(R.wallClockMs, undefined); // no authoritative wall-clock without observed run boundaries
  assert.equal(R.aggregateAgentMs.value, 2700000);
  assert.equal(R.aggregateAgentMs.status, "authoritative");
  assert.equal(R.aggregateAgentMs.scope, "observed-spans"); // scope stated explicitly
  assert.equal(R.criticalPath.field, "estimatedActiveCriticalPathMs");
  assert.equal(R.criticalPath.value, 2220000); // impl + max(std,adv) + fix + gate
  assert.equal(R.criticalPath.status, "estimated");
  assert.equal(R.criticalPath.edgesInferred, true);
  assert.equal(R.residualUnobservedElapsedMs.value, 180000);
  assert.equal(R.residualUnobservedElapsedMs.status, "estimated");
  assert.ok(/does NOT prove/i.test(R.residualUnobservedElapsedMs.note));
  assert.ok(R.residualUnobservedElapsedMs.possibleCauses.length >= 5); // neutral, multi-cause
  assert.equal(R.aggregateMinusCriticalMs.value, 480000); // the off-path 8m standard review
});

test("golden: reviewer-value + rework are UNAVAILABLE (no ReviewResult)", () => {
  assert.equal(report.rollup.reworkFindings.status, "unavailable");
  assert.equal(report.rollup.adversarialUniqueFindings.status, "unavailable");
});

test("golden: illustrative labelling states edges/critical are inferred", () => {
  assert.equal(report.reportLabel, "ILLUSTRATIVE");
  assert.equal(report.provenance, "historical");
  assert.equal(report.edgesInferred, true);
  assert.ok(report.knownUnknowns.some((u) => /INFERRED from stage order/i.test(u)));
  assert.ok(report.knownUnknowns.some((u) => /SPAN ENVELOPE, not run wall-clock/i.test(u)));
  const md = renderMarkdown(report);
  assert.ok(md.includes("ILLUSTRATIVE"));
  assert.ok(/edges are INFERRED/i.test(md));
});

test("golden: coverage counts (ambiguousReview grouped separately)", () => {
  const c = report.coverage;
  assert.equal(c.spanCount, 5);
  assert.equal(c.stageInferred, 5);
  assert.equal(c.ambiguousReview, 0); // golden has explicit stages, none ambiguous
  assert.equal(c.stageUnknown, 0);
  assert.equal(c.baseHeadUnknown, 5);
  assert.equal(c.timestampsPresent, 5);
});

test("knownUnknowns are provenance-aware: forward drops historical-only lines, historical keeps them", () => {
  const forwardSpans = [
    { spanId: "f1", stage: "implement", stageClass: "observed", taskId: "task-1",
      startedAtEpochMs: 1000, endedAtEpochMs: 2000, parentSpanId: null, outputTokens: 0 },
  ];
  const forward = analyzeRun({
    spans: forwardSpans, edgesObserved: true, provenance: "forward",
    runStartEpochMs: 1000, runEndEpochMs: 2000, coverageComplete: true,
  });
  // Forward runs observe run boundaries and can carry fastMode/effort/commits, so the
  // three historical-only caveats do NOT apply.
  assert.ok(!forward.knownUnknowns.some((u) => /requires forward-log/i.test(u)),
    "forward report must not claim fastMode/effort require a forward-log");
  assert.ok(!forward.knownUnknowns.some((u) => /SPAN ENVELOPE, not run wall-clock/i.test(u)));
  assert.ok(!forward.knownUnknowns.some((u) => /unknown historically/i.test(u)));
  // But non-historical lines survive (no over-removal).
  assert.ok(forward.knownUnknowns.some((u) => /review outcome\/findings\/rework/i.test(u)));

  // Historical report STILL carries all three historical-only caveats.
  assert.ok(report.knownUnknowns.some((u) => /requires forward-log/i.test(u)));
  assert.ok(report.knownUnknowns.some((u) => /SPAN ENVELOPE, not run wall-clock/i.test(u)));
  assert.ok(report.knownUnknowns.some((u) => /unknown historically/i.test(u)));
});

test("gitmetrics: no base..head range -> unknown, not fabricated", () => {
  const d = diffMetrics({ repoDir: ".", baseCommit: null, headCommit: null });
  assert.equal(d.status, "unknown");
  assert.equal(d.filesChanged, null);
  assert.ok(/no base\.\.head/i.test(d.reason));
});
