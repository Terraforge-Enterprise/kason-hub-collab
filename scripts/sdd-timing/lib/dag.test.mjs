import { test } from "node:test";
import assert from "node:assert/strict";
import { safeDurationMs, computeTimeModel, criticalPath } from "./dag.mjs";

// ---- Spec §4 sample task: parallel reviewers (8m std, 20m adv), fix, re-review, gate ----
const SPANS = [
  { spanId: "impl",    stage: "implement",          startedAtEpochMs: 0,       endedAtEpochMs: 360000 },
  { spanId: "rev-std", stage: "review-standard",    startedAtEpochMs: 420000,  endedAtEpochMs: 900000 },
  { spanId: "rev-adv", stage: "review-adversarial", startedAtEpochMs: 420000,  endedAtEpochMs: 1620000 },
  { spanId: "fix",     stage: "fix",                startedAtEpochMs: 1680000, endedAtEpochMs: 2040000 },
  { spanId: "rerev",   stage: "re-review",          startedAtEpochMs: 2100000, endedAtEpochMs: 2460000 },
  { spanId: "gate",    stage: "integration-gate",   startedAtEpochMs: 2520000, endedAtEpochMs: 2820000 },
];

// ---------- clock + time model ----------
test("safeDurationMs clamps missing/inverted to null (never negative)", () => {
  assert.equal(safeDurationMs(1000, 5000), 4000);
  assert.equal(safeDurationMs(5000, 1000), null);
  assert.equal(safeDurationMs(null, 5000), null);
  assert.equal(safeDurationMs(1000, null), null);
});

test("computeTimeModel: span envelope vs aggregate overlap-inclusive (envelope != wall-clock)", () => {
  const m = computeTimeModel(SPANS);
  assert.equal(m.spanEnvelopeMs, 2820000); // observed span envelope, NOT proven run wall-clock
  assert.equal(m.aggregateAgentMs, 3060000);
});

test("computeTimeModel: null/inverted-duration spans excluded and flagged", () => {
  const m = computeTimeModel([
    ...SPANS,
    { spanId: "inverted", startedAtEpochMs: 9000, endedAtEpochMs: 1000 },
    { spanId: "nullend", startedAtEpochMs: 100, endedAtEpochMs: null },
  ]);
  assert.equal(m.spanEnvelopeMs, 2820000);
  assert.deepEqual(m.excludedSpanIds, ["inverted", "nullend"]);
});

test("inferred: low-confidence review-ambiguous excluded by default, included on opt-in", () => {
  const spans = [
    { spanId: "impl", stage: "implement", startedAtEpochMs: 0, endedAtEpochMs: 60000 },
    { spanId: "amb", stage: "review-ambiguous", startedAtEpochMs: 60000, endedAtEpochMs: 660000 }, // 10m
  ];
  const def = criticalPath(spans, { edgesObserved: false });
  assert.equal(def.valueMs, 60000); // ambiguous excluded from the stage path by default
  assert.ok(def.dataQualityErrors.some((e) => /review-ambiguous/i.test(e)));
  const inc = criticalPath(spans, { edgesObserved: false, includeLowConfidence: true });
  assert.equal(inc.valueMs, 660000); // opt-in places it at the review rank
});

// ---------- inferred mode (historical) ----------
test("inferred: overlapping same-rank reviewers contribute MAX not SUM", () => {
  const cp = criticalPath(SPANS, { edgesObserved: false });
  assert.equal(cp.valueMs, 2580000); // impl(6)+max(8,20)+fix(6)+rerev(6)+gate(5)
});

test("inferred: SEQUENTIAL (non-overlapping) same-rank reviewers SUM, not max-merge", () => {
  const spans = [
    { spanId: "impl", stage: "implement", startedAtEpochMs: 0, endedAtEpochMs: 60000 },
    { spanId: "r1", stage: "review-standard", startedAtEpochMs: 100000, endedAtEpochMs: 200000 }, // 100k
    { spanId: "r2", stage: "review-standard", startedAtEpochMs: 300000, endedAtEpochMs: 400000 }, // 100k, no overlap with r1
  ];
  const cp = criticalPath(spans, { edgesObserved: false });
  assert.equal(cp.valueMs, 60000 + 100000 + 100000); // 260000 — summed, NOT max(100,100)
});

test("inferred: lone slow reviewer keeps full duration on the path", () => {
  const spans = [
    { spanId: "impl", stage: "implement", startedAtEpochMs: 0, endedAtEpochMs: 60000 },
    { spanId: "rev", stage: "review-adversarial", startedAtEpochMs: 60000, endedAtEpochMs: 1260000 },
  ];
  assert.equal(criticalPath(spans, { edgesObserved: false }).valueMs, 1260000);
});

test("inferred: overlapping timestamps WITHOUT observed edges -> estimated + assumptions", () => {
  const cp = criticalPath(SPANS, { edgesObserved: false });
  assert.equal(cp.status, "estimated");
  assert.equal(cp.field, "estimatedActiveCriticalPathMs");
  assert.ok(cp.assumptions.some((a) => /overlap/i.test(a)), "must state overlap-as-proxy assumption");
});

test("inferred run NEVER produces authoritative criticalPathMs", () => {
  const cp = criticalPath(SPANS, { edgesObserved: false });
  assert.notEqual(cp.status, "authoritative");
  assert.notEqual(cp.field, "criticalPathMs");
});

test("inferred: unrecognized-stage spans are excluded and flagged (not force-placed)", () => {
  const cp = criticalPath(
    [...SPANS, { spanId: "mystery", stage: "brainstorm", startedAtEpochMs: 5, endedAtEpochMs: 999999 }],
    { edgesObserved: false }
  );
  assert.equal(cp.valueMs, 2580000); // mystery not added to path
  assert.ok(cp.dataQualityErrors.some((e) => /unrecognized stage/i.test(e)));
});

test("aggregate agent time >= estimated active critical path", () => {
  const agg = computeTimeModel(SPANS).aggregateAgentMs;
  const cp = criticalPath(SPANS, { edgesObserved: false }).valueMs;
  assert.ok(agg >= cp, `aggregate ${agg} must be >= critical path ${cp}`);
});

// ---------- observed mode (forward-log parentSpanId) ----------
test("observed: linear chain -> authoritative criticalPathMs = chain sum", () => {
  const spans = [
    { spanId: "a", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 10 },
    { spanId: "b", parentSpanId: "a", startedAtEpochMs: 10, endedAtEpochMs: 40 },
    { spanId: "c", parentSpanId: "b", startedAtEpochMs: 40, endedAtEpochMs: 55 },
  ];
  const cp = criticalPath(spans, { edgesObserved: true });
  assert.equal(cp.valueMs, 10 + 30 + 15);
  assert.equal(cp.status, "authoritative");
  assert.equal(cp.field, "criticalPathMs");
});

test("observed: nested parallel branches -> longest path wins", () => {
  // a -> {b -> {d,e}, c};  durations a10 b20 c10 d15 e5  => a,b,d = 45
  const spans = [
    { spanId: "a", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 10 },
    { spanId: "b", parentSpanId: "a", startedAtEpochMs: 10, endedAtEpochMs: 30 },
    { spanId: "c", parentSpanId: "a", startedAtEpochMs: 10, endedAtEpochMs: 20 },
    { spanId: "d", parentSpanId: "b", startedAtEpochMs: 30, endedAtEpochMs: 45 },
    { spanId: "e", parentSpanId: "b", startedAtEpochMs: 30, endedAtEpochMs: 35 },
  ];
  assert.equal(criticalPath(spans, { edgesObserved: true }).valueMs, 45);
});

test("observed: parallel spans with DIFFERENT parents -> not merged; max branch wins", () => {
  const spans = [
    { spanId: "a", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 10 },
    { spanId: "x", parentSpanId: "a", startedAtEpochMs: 10, endedAtEpochMs: 110 }, // 100
    { spanId: "b", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 20 },
    { spanId: "y", parentSpanId: "b", startedAtEpochMs: 20, endedAtEpochMs: 70 }, // 50
  ];
  assert.equal(criticalPath(spans, { edgesObserved: true }).valueMs, 110); // a->x
});

test("observed: disconnected components -> max component, still authoritative", () => {
  const spans = [
    { spanId: "a", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 5 },
    { spanId: "b", parentSpanId: "a", startedAtEpochMs: 5, endedAtEpochMs: 15 },
    { spanId: "p", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 3 }, // separate component
  ];
  const cp = criticalPath(spans, { edgesObserved: true });
  assert.equal(cp.valueMs, 15);
  assert.equal(cp.status, "authoritative");
});

test("observed MALFORMED: duplicate span IDs -> unavailable, null, error (no plausible number)", () => {
  const spans = [
    { spanId: "x", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 10 },
    { spanId: "x", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 20 },
  ];
  const cp = criticalPath(spans, { edgesObserved: true });
  assert.equal(cp.valueMs, null);
  assert.equal(cp.status, "unavailable");
  assert.ok(cp.dataQualityErrors.some((e) => /duplicate span ID/i.test(e)));
});

test("observed MALFORMED: missing parent -> incomplete + error, best-effort value", () => {
  const spans = [
    { spanId: "a", parentSpanId: null, startedAtEpochMs: 0, endedAtEpochMs: 10 },
    { spanId: "b", parentSpanId: "ghost", startedAtEpochMs: 10, endedAtEpochMs: 40 }, // dangling
  ];
  const cp = criticalPath(spans, { edgesObserved: true });
  assert.equal(cp.status, "incomplete");
  assert.ok(cp.dataQualityErrors.some((e) => /missing parent ghost/i.test(e)));
  assert.equal(cp.valueMs, 30); // b treated as root
});

test("observed MALFORMED: cycle -> unavailable, null, error (no infinite loop, no number)", () => {
  const spans = [
    { spanId: "a", parentSpanId: "b", startedAtEpochMs: 0, endedAtEpochMs: 10 },
    { spanId: "b", parentSpanId: "a", startedAtEpochMs: 0, endedAtEpochMs: 10 },
  ];
  const cp = criticalPath(spans, { edgesObserved: true });
  assert.equal(cp.valueMs, null);
  assert.equal(cp.status, "unavailable");
  assert.ok(cp.dataQualityErrors.some((e) => /cycle/i.test(e)));
});
