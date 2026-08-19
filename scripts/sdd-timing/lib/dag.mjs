// Observational SDD timing — time model + critical-path estimation.
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md §3/§4.
// Pure functions only; no I/O, no side effects on the SDD workflow.
//
// Two critical-path modes:
//   - OBSERVED edges (forward-log parentSpanId): real DAG longest-path, with
//     validation (duplicate IDs / cycles / dangling parents). Malformed graphs
//     return status "unavailable"/"incomplete" + dataQualityErrors — never a
//     silently plausible number.
//   - INFERRED edges (historical): layered by SDD stage rank; same-rank spans are
//     clustered by temporal OVERLAP (a flagged parallelism proxy) so sequential
//     same-rank spans SUM while overlapping ones max-merge. Always "estimated".

/** Duration from epoch ts, clamped so a backwards clock never yields a negative (§4). */
export function safeDurationMs(startedAtEpochMs, endedAtEpochMs) {
  if (startedAtEpochMs == null || endedAtEpochMs == null) return null;
  const d = endedAtEpochMs - startedAtEpochMs;
  return d < 0 ? null : d;
}

function withDurations(spans) {
  const withDur = [];
  const excludedSpanIds = [];
  for (const s of spans) {
    // Prefer an explicit (e.g. forward MONOTONIC) durationMs when present; else epoch-derive.
    const durationMs =
      typeof s.durationMs === "number" && Number.isFinite(s.durationMs) && s.durationMs >= 0
        ? s.durationMs
        : safeDurationMs(s.startedAtEpochMs, s.endedAtEpochMs);
    if (durationMs == null) excludedSpanIds.push(s.spanId);
    else withDur.push({ ...s, durationMs });
  }
  return { withDur, excludedSpanIds };
}

/** Four quantities, never conflated (§4). wallClock = elapsed; aggregate = overlap-inclusive. */
export function computeTimeModel(spans) {
  const { withDur, excludedSpanIds } = withDurations(spans);
  if (withDur.length === 0) return { spanEnvelopeMs: null, aggregateAgentMs: 0, excludedSpanIds };
  const minStart = Math.min(...withDur.map((s) => s.startedAtEpochMs));
  const maxEnd = Math.max(...withDur.map((s) => s.endedAtEpochMs));
  const aggregateAgentMs = withDur.reduce((a, s) => a + s.durationMs, 0);
  // spanEnvelopeMs = max(observed span end) - min(observed span start). This is an
  // OBSERVED SPAN ENVELOPE, not proven run wall-clock — there are no run-start/run-end
  // events and span-set completeness is unproven (§2 correction).
  return { spanEnvelopeMs: maxEnd - minStart, aggregateAgentMs, excludedSpanIds };
}

// Canonical SDD per-task stage layering (inferred mode only).
const STAGE_RANK = {
  dispatch: 0,
  implement: 0,
  "evidence-gate": 1,
  review: 2,
  "review-standard": 2,
  "review-adversarial": 2,
  fix: 3,
  "re-review": 4,
  "integration-gate": 5,
  commit: 6,
};
const rankOf = (stage) =>
  Object.prototype.hasOwnProperty.call(STAGE_RANK, stage) ? STAGE_RANK[stage] : null;

function duplicateIds(spans) {
  const seen = new Set();
  const dups = new Set();
  for (const s of spans) {
    if (seen.has(s.spanId)) dups.add(s.spanId);
    seen.add(s.spanId);
  }
  return [...dups];
}

function clusterByOverlap(spans) {
  const sorted = [...spans].sort((a, b) => a.startedAtEpochMs - b.startedAtEpochMs);
  const clusters = [];
  let cur = null;
  for (const s of sorted) {
    if (cur && s.startedAtEpochMs <= cur.maxEnd) {
      cur.spans.push(s);
      cur.maxEnd = Math.max(cur.maxEnd, s.endedAtEpochMs);
    } else {
      cur = { spans: [s], maxEnd: s.endedAtEpochMs };
      clusters.push(cur);
    }
  }
  return clusters;
}

function longestPathObserved(withDur) {
  const dups = duplicateIds(withDur);
  if (dups.length) {
    return {
      valueMs: null, field: "criticalPathMs", status: "unavailable", confidence: null,
      assumptions: [], dataQualityErrors: [`duplicate span IDs: ${dups.join(", ")}`],
    };
  }
  const byId = new Map(withDur.map((s) => [s.spanId, s]));
  const children = new Map(withDur.map((s) => [s.spanId, []]));
  const errors = [];
  let incomplete = false;
  for (const s of withDur) {
    const p = s.parentSpanId;
    if (p == null) continue; // root
    if (!byId.has(p)) {
      errors.push(`span ${s.spanId} references missing parent ${p}`);
      incomplete = true; // dangling edge dropped -> treated as root
    } else {
      children.get(p).push(s.spanId);
    }
  }
  // cycle detection (DFS coloring: 0 unvisited, 1 visiting, 2 done)
  const color = new Map();
  let cyclePath = null;
  const dfs = (id, stack) => {
    color.set(id, 1);
    stack.push(id);
    for (const c of children.get(id)) {
      const cc = color.get(c) || 0;
      if (cc === 1) { cyclePath = [...stack, c]; return true; }
      if (cc === 0 && dfs(c, stack)) return true;
    }
    stack.pop();
    color.set(id, 2);
    return false;
  };
  for (const s of withDur) {
    if ((color.get(s.spanId) || 0) === 0 && dfs(s.spanId, [])) break;
  }
  if (cyclePath) {
    return {
      valueMs: null, field: "criticalPathMs", status: "unavailable", confidence: null,
      assumptions: [], dataQualityErrors: [`cycle detected: ${cyclePath.join(" -> ")}`],
    };
  }
  // longest downward chain (memoized), max over all nodes -> handles disconnected components
  const memo = new Map();
  const down = (id) => {
    if (memo.has(id)) return memo.get(id);
    let best = 0;
    for (const c of children.get(id)) best = Math.max(best, down(c));
    const v = (byId.get(id).durationMs || 0) + best;
    memo.set(id, v);
    return v;
  };
  let valueMs = 0;
  for (const s of withDur) valueMs = Math.max(valueMs, down(s.spanId));
  return {
    valueMs, field: "criticalPathMs",
    status: incomplete ? "incomplete" : "authoritative",
    confidence: incomplete ? "medium" : "high",
    assumptions: [], dataQualityErrors: errors,
  };
}

function estimatedPathInferred(withDur, { includeLowConfidence = false } = {}) {
  const dups = duplicateIds(withDur);
  if (dups.length) {
    return {
      valueMs: null, field: "estimatedActiveCriticalPathMs", status: "unavailable", confidence: null,
      assumptions: [], dataQualityErrors: [`duplicate span IDs: ${dups.join(", ")}`],
    };
  }
  const byTask = new Map();
  for (const s of withDur) {
    const t = s.taskId ?? "__single__";
    if (!byTask.has(t)) byTask.set(t, []);
    byTask.get(t).push(s);
  }
  let valueMs = 0;
  let unranked = 0;
  let ambiguousExcluded = 0;
  for (const taskSpans of byTask.values()) {
    const byRank = new Map();
    for (const s of taskSpans) {
      let r = rankOf(s.stage);
      if (s.stage === "review-ambiguous") {
        // low-confidence generic 'review' — excluded from the stage-specific path by
        // default; opt in via includeLowConfidence for exploratory reporting only.
        r = includeLowConfidence ? 2 : null;
        if (r == null) { ambiguousExcluded++; continue; }
      }
      if (r == null) { unranked++; continue; }
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(s);
    }
    for (const rankSpans of byRank.values()) {
      for (const cluster of clusterByOverlap(rankSpans)) {
        valueMs += Math.max(...cluster.spans.map((s) => s.durationMs));
      }
    }
  }
  const errors = [];
  if (unranked) errors.push(`${unranked} span(s) with unrecognized stage excluded from estimated path`);
  if (ambiguousExcluded) errors.push(`${ambiguousExcluded} low-confidence 'review-ambiguous' span(s) excluded from estimated path (set includeLowConfidence to include)`);
  return {
    valueMs, field: "estimatedActiveCriticalPathMs", status: "estimated", confidence: "low",
    includeLowConfidence,
    assumptions: [
      "edges INFERRED from SDD stage order, not observed parent relationships",
      "same-rank spans clustered by temporal overlap as a parallelism proxy (not observed sibling edges)",
      "tasks assumed sequential (task[N] gate precedes task[N+1] implement)",
      `low-confidence 'review-ambiguous' spans ${includeLowConfidence ? "INCLUDED" : "excluded"} from the path`,
    ],
    dataQualityErrors: errors,
  };
}

/**
 * Critical path. `edgesObserved: true` uses parentSpanId (authoritative DAG);
 * otherwise the historical stage-layered estimate. Return shape is uniform:
 * { valueMs, field, status, confidence, assumptions, dataQualityErrors }.
 */
export function criticalPath(spans, { edgesObserved, includeLowConfidence = false } = {}) {
  const { withDur } = withDurations(spans);
  return edgesObserved ? longestPathObserved(withDur) : estimatedPathInferred(withDur, { includeLowConfidence });
}
