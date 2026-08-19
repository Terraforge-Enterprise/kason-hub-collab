import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLogger, assembleRunFromEvents } from "./forward-log.mjs";
import { analyzeForwardEvents } from "../analyze.mjs";

function fakeClock() {
  let epoch = 1_000_000;
  let mono = 0n;
  return {
    now: () => epoch,
    mono: () => mono,
    advance: (ms) => { epoch += ms; mono += BigInt(ms) * 1_000_000n; },
  };
}
const tmp = () => mkdtempSync(join(tmpdir(), "sddfw-"));
// raw event-file writer for corruption cases (full control over bytes)
function writeRaw(dir, runId, lines) {
  mkdirSync(join(dir, runId), { recursive: true });
  writeFileSync(join(dir, runId, "w.jsonl"), lines.join("\n") + "\n");
}
const ev = (o) => JSON.stringify({ schemaVersion: "1.0.0", instrumentationVersion: "t", runId: "r", writerId: "w", ...o });

// ---------------- happy-path event lifecycle ----------------
test("lifecycle: run→task→span→span→task→run assembles with observed edges + monotonic durations", () => {
  const dir = tmp(), c = fakeClock();
  const L = new RunLogger({ runId: "r1", eventsDir: dir, clock: c, instrumentationVersion: "sdd-timing/1.0.0+test" });
  L.runStart();
  c.advance(1000); L.taskDispatch("task-1");
  c.advance(1000); L.spanStart({ spanId: "impl", taskId: "task-1", stage: "implement", parentSpanId: null, model: "claude-opus-4-8", fastMode: true, effort: "xhigh", baseCommit: "aaa" });
  c.advance(360000); L.spanEnd({ spanId: "impl", headCommit: "bbb" });
  c.advance(1000); L.spanStart({ spanId: "review", taskId: "task-1", stage: "review-adversarial", parentSpanId: "impl" });
  c.advance(1200000); L.spanEnd({ spanId: "review" });
  c.advance(1000); L.taskComplete("task-1");
  c.advance(1000); L.runEnd();

  const run = assembleRunFromEvents(dir, "r1");
  assert.equal(run.runStartEpochMs, 1_000_000);
  assert.equal(run.runEndEpochMs, 2_565_000);
  assert.equal(run.coverageComplete, true);
  assert.equal(run.edgesObserved, true);
  const impl = run.spans.find((s) => s.spanId === "impl");
  const rev = run.spans.find((s) => s.spanId === "review");
  assert.equal(impl.durationMs, 360000);
  assert.equal(impl.durationClock, "monotonic"); // from hrtime, not epoch
  assert.equal(impl.fastMode, true);
  assert.equal(impl.effort, "xhigh");
  assert.equal(impl.baseCommit, "aaa");
  assert.equal(impl.headCommit, "bbb");
  assert.equal(impl.baseHeadClass, "observed");
  assert.equal(rev.parentSpanId, "impl"); // observed dependency edge
  assert.equal(rev.durationMs, 1200000);
});

test("lifecycle → analyzeForwardEvents yields AUTHORITATIVE wall-clock + critical path", () => {
  const dir = tmp(), c = fakeClock();
  const L = new RunLogger({ runId: "r2", eventsDir: dir, clock: c });
  L.runStart();
  c.advance(2000); L.spanStart({ spanId: "impl", taskId: "task-1", stage: "implement", parentSpanId: null });
  c.advance(360000); L.spanEnd({ spanId: "impl" });
  c.advance(1000); L.spanStart({ spanId: "review", taskId: "task-1", stage: "review-adversarial", parentSpanId: "impl" });
  c.advance(1200000); L.spanEnd({ spanId: "review" });
  c.advance(1000); L.runEnd();

  const rep = analyzeForwardEvents(dir, "r2");
  assert.equal(rep.provenance, "forward");
  assert.equal(rep.reportLabel, "measured");
  assert.equal(rep.rollup.wallClockMs.status, "authoritative");
  assert.equal(rep.rollup.wallClockMs.value, 1_564_000); // runEnd(2_564_000) − runStart(1_000_000)
  assert.equal(rep.rollup.criticalPath.field, "criticalPathMs");   // observed edges
  assert.equal(rep.rollup.criticalPath.status, "authoritative");
  assert.equal(rep.rollup.criticalPath.value, 1560000);            // impl->review chain
  assert.equal(rep.rollup.criticalPath.edgesInferred, false);
});

// ---------------- failure paths ----------------
test("crash: missing run-end → coverage incomplete, wall-clock NOT authoritative", () => {
  const dir = tmp(), c = fakeClock();
  const L = new RunLogger({ runId: "r3", eventsDir: dir, clock: c });
  L.runStart();
  c.advance(2000); L.spanStart({ spanId: "impl", taskId: "task-1", stage: "implement" });
  c.advance(360000); L.spanEnd({ spanId: "impl" });
  // NO runEnd — crashed
  const run = assembleRunFromEvents(dir, "r3");
  assert.equal(run.runEndEpochMs, null);
  assert.equal(run.coverageComplete, false);
  const rep = analyzeForwardEvents(dir, "r3");
  assert.equal(rep.rollup.wallClockMs.status, "incomplete");
  assert.equal(rep.rollup.wallClockMs.value, null);
});

test("duplicate event (same eventId) → deduped + surfaced in dataQuality", () => {
  const dir = tmp();
  const dup = ev({ eventId: "E1", type: "run-start", seq: 0, epochMs: 1000, monoNs: "0" });
  writeRaw(dir, "r4", [dup, dup, ev({ eventId: "E2", type: "run-end", seq: 1, epochMs: 2000, monoNs: "0" })]);
  const run = assembleRunFromEvents(dir, "r4");
  assert.equal(run.dataQuality.duplicateEvents, 1);
  assert.equal(run.coverageComplete, false); // dup makes coverage untrustworthy
});

test("out-of-order (decreasing seq per writer) → surfaced, not silently normalised", () => {
  const dir = tmp();
  writeRaw(dir, "r5", [
    ev({ eventId: "A", type: "run-start", seq: 5, epochMs: 1000, monoNs: "0" }),
    ev({ eventId: "B", type: "run-end", seq: 3, epochMs: 2000, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "r5");
  assert.equal(run.dataQuality.outOfOrder, 1);
  assert.equal(run.coverageComplete, false);
});

test("malformed event line → counted, does not crash the reader", () => {
  const dir = tmp();
  writeRaw(dir, "r6", [
    ev({ eventId: "A", type: "run-start", seq: 0, epochMs: 1000, monoNs: "0" }),
    "{ this is not valid json",
    ev({ eventId: "B", type: "run-end", seq: 1, epochMs: 2000, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "r6");
  assert.equal(run.dataQuality.malformedEvents, 1);
  assert.equal(run.coverageComplete, false);
});

test("unpaired span-start (no span-end) → flagged, coverage incomplete", () => {
  const dir = tmp();
  writeRaw(dir, "r7", [
    ev({ eventId: "A", type: "run-start", seq: 0, epochMs: 1000, monoNs: "0" }),
    ev({ eventId: "B", type: "span-start", spanId: "x", seq: 1, epochMs: 1100, monoNs: "0" }),
    ev({ eventId: "C", type: "run-end", seq: 2, epochMs: 2000, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "r7");
  assert.deepEqual(run.dataQuality.unpairedSpanStarts, ["x"]);
  assert.equal(run.coverageComplete, false);
});

test("coverage-interrupt event → run marked incomplete", () => {
  const dir = tmp();
  writeRaw(dir, "r8", [
    ev({ eventId: "A", type: "run-start", seq: 0, epochMs: 1000, monoNs: "0" }),
    ev({ eventId: "I", type: "coverage-interrupt", reason: "controller killed", seq: 1, epochMs: 1500, monoNs: "0" }),
    ev({ eventId: "Z", type: "run-end", seq: 2, epochMs: 2000, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "r8");
  assert.deepEqual(run.dataQuality.interrupts, ["controller killed"]);
  assert.equal(run.coverageComplete, false);
});

test("writer is non-blocking: bad event dir → no throw, stderr warning, event still returned", () => {
  // point eventsDir at a FILE so mkdir of the run subdir fails
  const base = tmp();
  const asFile = join(base, "not-a-dir");
  writeFileSync(asFile, "x");
  const L = new RunLogger({ runId: "r9", eventsDir: asFile });
  let threw = false;
  let event;
  try { event = L.runStart(); L.spanStart({ spanId: "impl" }); } catch { threw = true; }
  assert.equal(threw, false);            // never throws — cannot break the workflow
  assert.ok(event && event.type === "run-start"); // still returns the event object
  assert.ok(L.stderrWarnings > 0);       // but NOT silent
});
