// Observational SDD timing — FORWARD logger + event reader.
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md §5.
//
// Writer: RunLogger appends validated events to a PER-WRITER file
//   <eventsDir>/<runId>/<writerId>.jsonl  (single writer per file → no concurrent-write race).
// Non-blocking + never throws: a write failure emits a concise stderr warning and is
// counted; it never alters the caller's control flow or exit behaviour.
// Reader: assembleRunFromEvents dedups by eventId, flags duplicate/malformed/out-of-order/
// unpaired events into dataQuality (never silently normalised), and reconstructs run
// boundaries + observed-edge spans. A missing run-end ⇒ coverageComplete:false (a crashed
// run cannot look complete).

import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const EVENT_SCHEMA_VERSION = "1.0.0";
export const EVENT_TYPES = [
  "run-start", "run-end", "task-dispatch", "task-complete", "task-failed",
  "span-start", "span-end", "coverage-interrupt", "error",
  "gate-start", "gate-end", "gate-interrupted",
];

export class RunLogger {
  constructor({ runId, eventsDir, instrumentationVersion = "sdd-timing/1.0.0", clock } = {}) {
    this.runId = runId;
    this.instrumentationVersion = instrumentationVersion;
    this.writerId = randomUUID();
    this.seq = 0;
    this.stderrWarnings = 0;
    this._now = (clock && clock.now) || (() => Date.now());
    this._mono = (clock && clock.mono) || (() => process.hrtime.bigint());
    this.file = null;
    try {
      const dir = join(eventsDir, String(runId));
      mkdirSync(dir, { recursive: true });
      this.file = join(dir, `${this.writerId}.jsonl`);
    } catch (e) {
      this._warn(`failed to init event dir: ${e && e.message}`);
    }
  }

  _warn(msg) {
    this.stderrWarnings++;
    try { process.stderr.write(`[sdd-timing] ${msg}\n`); } catch { /* never throw */ }
  }

  // Observational + non-blocking: returns the event object; never throws.
  emit(type, fields = {}) {
    const ev = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      instrumentationVersion: this.instrumentationVersion,
      eventId: randomUUID(),
      writerId: this.writerId,
      runId: this.runId,
      type,
      seq: this.seq++,
      epochMs: this._now(),        // epoch correlation timestamp
      monoNs: this._mono().toString(), // monotonic reading (durations, same-writer only)
      ...fields,
    };
    if (!this.file) { this._warn(`dropped ${type} (no event file)`); return ev; }
    try { appendFileSync(this.file, JSON.stringify(ev) + "\n"); }
    catch (e) { this._warn(`failed to write ${type}: ${e && e.message}`); }
    return ev;
  }

  runStart(f = {}) { return this.emit("run-start", f); }
  runEnd(f = {}) { return this.emit("run-end", f); }
  taskDispatch(taskId, f = {}) { return this.emit("task-dispatch", { taskId, ...f }); }
  taskComplete(taskId, f = {}) { return this.emit("task-complete", { taskId, ...f }); }
  spanStart(f = {}) { return this.emit("span-start", f); }   // {spanId, taskId, stage, parentSpanId, dependsOnSpanIds, model, fastMode, effort, baseCommit}
  spanEnd(f = {}) { return this.emit("span-end", f); }       // {spanId, headCommit}
  coverageInterrupt(reason, f = {}) { return this.emit("coverage-interrupt", { reason, ...f }); }
  error(message, f = {}) { return this.emit("error", { message, ...f }); }
}

export function readEventFiles(eventsDir, runId) {
  const dir = join(eventsDir, String(runId));
  const events = [];
  let malformedEvents = 0, files = 0;
  if (!existsSync(dir)) return { events, malformedEvents, files };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    files++;
    for (const raw of readFileSync(join(dir, f), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { malformedEvents++; }
    }
  }
  return { events, malformedEvents, files };
}

export function assembleRunFromEvents(eventsDir, runId) {
  const { events, malformedEvents } = readEventFiles(eventsDir, runId);
  const dataQuality = {
    malformedEvents, duplicateEvents: 0, outOfOrder: 0,
    unpairedSpanStarts: [], unpairedSpanEnds: [], multipleRunStart: false,
    interrupts: [], errors: [], instrumentationVersions: [],
  };

  // dedup by eventId (stable IDs) — surfaced, not silently dropped
  const seen = new Set();
  const deduped = [];
  const versions = new Set();
  for (const e of events) {
    if (e && e.eventId != null) {
      if (seen.has(e.eventId)) { dataQuality.duplicateEvents++; continue; }
      seen.add(e.eventId);
    }
    deduped.push(e);
    if (e && e.instrumentationVersion) versions.add(e.instrumentationVersion);
  }
  dataQuality.instrumentationVersions = [...versions];

  // out-of-order per writer (seq must be monotonically increasing)
  const lastSeq = new Map();
  for (const e of deduped) {
    if (e && e.writerId != null && typeof e.seq === "number") {
      const prev = lastSeq.get(e.writerId);
      if (prev != null && e.seq <= prev) dataQuality.outOfOrder++;
      lastSeq.set(e.writerId, prev == null ? e.seq : Math.max(prev, e.seq));
    }
  }

  const byType = (t) => deduped.filter((e) => e && e.type === t);
  const runStarts = byType("run-start");
  const runEnds = byType("run-end");
  if (runStarts.length > 1) dataQuality.multipleRunStart = true;
  const runStartEpochMs = runStarts.length ? Math.min(...runStarts.map((e) => e.epochMs)) : null;
  const runEndEpochMs = runEnds.length ? Math.max(...runEnds.map((e) => e.epochMs)) : null;

  for (const e of byType("coverage-interrupt")) dataQuality.interrupts.push(e.reason || "interrupt");
  for (const e of byType("task-failed")) dataQuality.interrupts.push(`task ${e.taskId ?? "?"} failed: ${e.reason || "failed"}`);
  for (const e of byType("error")) dataQuality.errors.push(e.message || "error");

  // pair span-start / span-end by spanId
  const starts = new Map(), ends = new Map();
  for (const e of deduped) {
    if (e && e.type === "span-start" && e.spanId != null && !starts.has(e.spanId)) starts.set(e.spanId, e);
    if (e && e.type === "span-end" && e.spanId != null && !ends.has(e.spanId)) ends.set(e.spanId, e);
  }
  const spans = [];
  for (const [spanId, s] of starts) {
    const e = ends.get(spanId);
    if (!e) dataQuality.unpairedSpanStarts.push(spanId);
    let durationMs = null, durationClock = "unknown";
    if (e) {
      if (s.writerId === e.writerId && s.monoNs != null && e.monoNs != null) {
        const d = Number(BigInt(e.monoNs) - BigInt(s.monoNs)) / 1e6; // monotonic
        durationMs = d < 0 ? null : d;
        durationClock = "monotonic";
      } else if (s.epochMs != null && e.epochMs != null) {
        durationMs = Math.max(0, e.epochMs - s.epochMs); // cross-writer fallback
        durationClock = "epoch";
        dataQuality.errors.push(`span ${spanId}: cross-writer span pair — epoch-fallback duration`);
      }
    }
    spans.push({
      spanId, taskId: s.taskId ?? null,
      stage: s.stage ?? "unknown",
      stageClass: s.stage ? "observed" : "unknown",
      stageConfidence: s.stage ? "high" : null,
      parentSpanId: s.parentSpanId ?? null,
      dependsOnSpanIds: Array.isArray(s.dependsOnSpanIds) ? s.dependsOnSpanIds : [],
      startedAtEpochMs: s.epochMs ?? null,
      endedAtEpochMs: e ? e.epochMs ?? null : null,
      durationMs, durationClock,
      model: s.model ?? null, fastMode: s.fastMode ?? null, effort: s.effort ?? null,
      baseCommit: s.baseCommit ?? null,
      headCommit: e ? e.headCommit ?? null : null,
      baseHeadClass: s.baseCommit && e && e.headCommit ? "observed" : "unknown",
      dataQuality: { confidence: "high", missingFields: [], inferenceNotes: [], instrumentationErrors: [], errors: [], malformedLines: 0 },
    });
  }
  for (const [spanId] of ends) if (!starts.has(spanId)) dataQuality.unpairedSpanEnds.push(spanId);

  // --- gates: pair gate-start with gate-end/gate-interrupted by gateId ---
  const gateStarts = new Map(), gateEnds = new Map();
  for (const e of deduped) {
    if (e && e.type === "gate-start" && e.gateId != null && !gateStarts.has(e.gateId)) gateStarts.set(e.gateId, e);
    if (e && (e.type === "gate-end" || e.type === "gate-interrupted") && e.gateId != null && !gateEnds.has(e.gateId)) gateEnds.set(e.gateId, e);
  }
  const gates = [];
  const gateIssues = [];   // hard: force coverageComplete=false
  const gateWarnings = []; // soft: surfaced, do NOT force incomplete
  for (const [gateId, s] of gateStarts) {
    const e = gateEnds.get(gateId);
    if (!e) gateIssues.push(`gate ${gateId}: missing gate-end/gate-interrupted`);
    if (s.argv == null) gateIssues.push(`gate ${gateId}: malformed/incomplete gate-start (no argv)`);
    if (e && s.runId != null && e.runId != null && s.runId !== e.runId) gateIssues.push(`gate ${gateId}: run ID mismatch (${s.runId} vs ${e.runId})`);

    const intended = s.intendedGateCommit ?? null;                 // controller-claimed
    const observedBefore = s.observedGateCommitBefore ?? null;     // wrapper-observed HEAD
    const observedAfter = e ? e.observedGateCommitAfter ?? null : null;
    const commitObservable = observedBefore != null;
    const intendedVsObservedMismatch = intended != null && observedBefore != null && intended !== observedBefore;
    const observedChangedDuringGate = observedBefore != null && observedAfter != null && observedBefore !== observedAfter;
    const dirtyWorktree = !!s.dirtyWorktreeBefore || !!(e && e.dirtyWorktreeAfter);
    // "matched" is asserted ONLY from the OBSERVED value — never the controller claim alone.
    const commitMatch = (!commitObservable || intended == null) ? "unknown"
      : (intended === observedBefore && !observedChangedDuringGate ? "matched" : "mismatch");

    if (intendedVsObservedMismatch) gateIssues.push(`gate ${gateId}: intended commit ${intended} != observed HEAD ${observedBefore}`);
    if (observedChangedDuringGate) gateIssues.push(`gate ${gateId}: observed HEAD changed during gate (${observedBefore} -> ${observedAfter})`);
    if (!commitObservable) gateIssues.push(`gate ${gateId}: could not observe repo commit (${s.commitObsProvenance ?? "no provenance"})`);
    if (dirtyWorktree) gateWarnings.push(`gate ${gateId}: worktree dirty during gate (attribution to a clean commit is uncertain)`);

    let durationMs = null;
    if (e && s.writerId === e.writerId && s.monoNs != null && e.monoNs != null) {
      const d = Number(BigInt(e.monoNs) - BigInt(s.monoNs)) / 1e6;
      durationMs = d < 0 ? null : d;
    }
    gates.push({
      gateId, taskId: s.taskId ?? null,
      status: !e ? "incomplete" : (e.type === "gate-interrupted" ? "interrupted" : "complete"),
      exitCode: e ? e.exitCode ?? null : null,
      terminatingSignal: e ? e.terminatingSignal ?? null : null,
      durationMs, durationClock: durationMs != null ? "monotonic" : "unknown",
      intendedGateCommit: intended,
      observedGateCommit: observedBefore, observedGateCommitAfter: observedAfter,
      commitObservable, commitObsProvenance: s.commitObsProvenance ?? null,
      commitMatch, intendedVsObservedMismatch, observedChangedDuringGate, dirtyWorktree,
      argv: s.argv ?? null, displayCommand: s.displayCommand ?? null, cwd: s.cwd ?? null,
      testCount: e ? e.testCount ?? null : null,
      testCountProvenance: e ? e.testCountProvenance ?? null : null,
      cacheReported: e ? e.cacheReported ?? null : null,
    });
  }
  for (const [gateId] of gateEnds) if (!gateStarts.has(gateId)) gateIssues.push(`gate ${gateId}: gate-end without gate-start (mismatched ID)`);
  dataQuality.gateIssues = gateIssues;
  dataQuality.gateWarnings = gateWarnings;

  // A crashed/interrupted run must NOT look complete.
  const coverageComplete =
    runStartEpochMs != null && runEndEpochMs != null &&
    dataQuality.malformedEvents === 0 && dataQuality.duplicateEvents === 0 &&
    dataQuality.outOfOrder === 0 && dataQuality.unpairedSpanStarts.length === 0 &&
    dataQuality.interrupts.length === 0 && !dataQuality.multipleRunStart &&
    gateIssues.length === 0;

  return { runId, runStartEpochMs, runEndEpochMs, coverageComplete, edgesObserved: true, spans, gates, dataQuality };
}
