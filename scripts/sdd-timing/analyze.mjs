#!/usr/bin/env node
// Observational SDD timing — POST-HOC analyzer (pure reader).
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md
// Reads a run's `subagents/` dir (agent-*.jsonl + *.meta.json) and emits a
// status-tagged report. Writes ONLY its own output files; never on the SDD path.
// Historical runs are labelled ILLUSTRATIVE and MUST NOT drive workflow changes.

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTranscript } from "./lib/transcript.mjs";
import { computeTimeModel, criticalPath } from "./lib/dag.mjs";
import { assembleRunFromEvents } from "./lib/forward-log.mjs";

export function loadSpans(subagentsDir) {
  const files = readdirSync(subagentsDir)
    .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  const spans = [];
  for (const f of files) {
    const spanId = basename(f, ".jsonl").replace(/^agent-/, "");
    const jsonlText = readFileSync(join(subagentsDir, f), "utf8");
    const metaPath = join(subagentsDir, f.replace(/\.jsonl$/, ".meta.json"));
    let meta = null;
    if (existsSync(metaPath)) { try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* leave null */ } }
    spans.push(parseTranscript({ jsonlText, meta, spanId }));
  }
  spans.sort((a, b) =>
    (a.startedAtEpochMs ?? Infinity) - (b.startedAtEpochMs ?? Infinity) || a.spanId.localeCompare(b.spanId));
  return spans;
}

const tag = (value, status, extra = {}) => ({ value, status, ...extra });

function computeCoverage(spans) {
  const n = spans.length;
  const c = { spanCount: n, stageInferred: 0, stageUnknown: 0, ambiguousReview: 0, modelPresent: 0,
    timestampsPresent: 0, baseHeadUnknown: 0, findingsUnavailable: n, withDataQualityErrors: 0 };
  for (const s of spans) {
    if (s.stage === "review-ambiguous") c.ambiguousReview++;      // grouped separately
    else if (s.stageClass === "inferred") c.stageInferred++;
    if (s.stageClass === "unknown") c.stageUnknown++;
    if (s.model) c.modelPresent++;
    if (s.startedAtEpochMs != null && s.endedAtEpochMs != null) c.timestampsPresent++;
    if (s.baseHeadClass === "unknown") c.baseHeadUnknown++;
    if (s.dataQuality?.errors?.length) c.withDataQualityErrors++;
  }
  return c;
}

export function analyzeRun({
  subagentsDir, spans: providedSpans, edgesObserved = false, includeLowConfidence = false,
  runId = "unknown-run", provenance = "historical",
  runStartEpochMs = null, runEndEpochMs = null, coverageComplete = false,
}) {
  const spans = providedSpans ?? loadSpans(subagentsDir);
  const tm = computeTimeModel(spans);
  const cp = criticalPath(spans, { edgesObserved, includeLowConfidence });

  const envelope = tm.spanEnvelopeMs;
  const cpKnown = cp.valueMs != null;
  const derivedStatus = edgesObserved ? "authoritative" : "estimated";

  // Authoritative run wall-clock ONLY with observed run-start + run-end (same run) AND
  // uninterrupted coverage AND observed edges. Otherwise we have only a span envelope.
  const haveStart = runStartEpochMs != null, haveEnd = runEndEpochMs != null;
  const wallClockAuthoritative = haveStart && haveEnd && coverageComplete && edgesObserved;

  const residual = envelope != null && cpKnown ? Math.max(0, envelope - cp.valueMs) : null;
  const aggregateMinusCriticalMs = cpKnown ? Math.max(0, tm.aggregateAgentMs - cp.valueMs) : null;

  const rollup = {
    observedSpanEnvelopeMs: {
      value: envelope,
      status: envelope == null ? "unavailable" : (wallClockAuthoritative ? "authoritative" : "incomplete"),
      note: "max(observed span end) − min(observed span start); an OBSERVED SPAN ENVELOPE, not proven run wall-clock (no observed run-start/run-end; span-set completeness unproven)",
    },
    aggregateAgentMs: {
      value: tm.aggregateAgentMs, status: "authoritative", scope: "observed-spans",
      note: "sum over successfully-observed spans only; completeness of the span set is NOT proven",
    },
    criticalPath: {
      field: cp.field, value: cp.valueMs, status: cp.status, confidence: cp.confidence,
      edgesInferred: !edgesObserved,
      assumptions: cp.assumptions, dataQualityErrors: cp.dataQualityErrors,
    },
    residualUnobservedElapsedMs: {
      value: residual,
      status: residual == null ? "unavailable" : "estimated",
      formula: `observedSpanEnvelopeMs − ${cp.field}`,
      note: "unattributed elapsed gap; does NOT prove human-away/handoff time",
      possibleCauses: [
        "human idle", "controller queueing", "unrecorded controller work",
        "missing agent transcripts", "tool execution outside captured spans",
        "process startup", "orchestration delays", "incorrect inferred dependency edges",
        "genuine handoff delay",
      ],
    },
    aggregateMinusCriticalMs: tag(aggregateMinusCriticalMs, aggregateMinusCriticalMs == null ? "unavailable" : derivedStatus),
    reworkFindings: tag(null, "unavailable", { reason: "no ReviewResult artifact / reworkOfFindingIds (§1)" }),
    adversarialUniqueFindings: tag(null, "unavailable", { reason: "structured findings required (§1)" }),
    excludedSpanIds: tm.excludedSpanIds,
  };

  // Authoritative wall-clock is emitted ONLY when proven; a run-end absence marks it incomplete.
  if (wallClockAuthoritative) {
    rollup.wallClockMs = { value: runEndEpochMs - runStartEpochMs, status: "authoritative", note: "observed run-start..run-end, coverage complete" };
  } else if (haveStart && !haveEnd) {
    rollup.wallClockMs = { value: null, status: "incomplete", note: "run-end absent — run interrupted/crashed; wall-clock unknown, coverage incomplete" };
  } else if (haveStart && haveEnd && !wallClockAuthoritative) {
    rollup.wallClockMs = { value: runEndEpochMs - runStartEpochMs, status: "incomplete", note: "run boundaries observed but coverage/edges not fully proven" };
  }

  return {
    schemaVersion: "1.0.0",
    runId, provenance,
    reportLabel: provenance === "historical" ? "ILLUSTRATIVE" : "measured",
    edgesInferred: !edgesObserved,
    includeLowConfidence,
    generatedFrom: subagentsDir ?? "forward-events",
    spanCount: spans.length,
    spans,
    rollup,
    coverage: computeCoverage(spans),
    knownUnknowns: [
      // Historical-only caveats: on a forward run, run boundaries ARE observed and
      // fastMode/effort/commits can be present, so these three do not apply.
      ...(provenance === "historical" ? [
        "observedSpanEnvelopeMs is a SPAN ENVELOPE, not run wall-clock (no run boundaries observed)",
        "baseCommit/headCommit — unknown historically (no commit field in artifacts, §2)",
        "fastMode/effort — unknown historically (requires forward-log)",
      ] : []),
      "review outcome/findings/rework/uniqueness — unavailable (no ReviewResult, §1)",
      "low-confidence generic 'review' grouped as review-ambiguous; excluded from the stage path unless includeLowConfidence",
      ...(edgesObserved ? [] : ["dependency edges are INFERRED from stage order; the critical path is ESTIMATED, not authoritative (§3)"]),
    ],
  };
}

// Forward path: assemble observed events → authoritative report (edges observed, and
// authoritative wall-clock only when run boundaries + coverage are proven).
export function analyzeForwardEvents(eventsDir, runId) {
  const run = assembleRunFromEvents(eventsDir, runId);
  const report = analyzeRun({
    spans: run.spans, edgesObserved: true, runId, provenance: "forward",
    runStartEpochMs: run.runStartEpochMs, runEndEpochMs: run.runEndEpochMs,
    coverageComplete: run.coverageComplete,
  });
  report.forwardDataQuality = run.dataQuality;
  report.gates = run.gates;
  return report;
}

// ---- markdown rendering ----
const ms = (v) => (v == null ? "—" : `${(v / 60000).toFixed(1)}m (${v}ms)`);
const line = (label, m) => `| ${label} | ${ms(m.value)} | \`${m.status}\` |`;

export function renderMarkdown(r) {
  const R = r.rollup;
  const out = [];
  out.push(`# SDD timing — ${r.runId}`);
  if (r.reportLabel === "ILLUSTRATIVE")
    out.push(`\n> **ILLUSTRATIVE** — reconstructed from a single ${r.provenance} run. Dependency edges are INFERRED and the critical path is ESTIMATED (not authoritative). The "span envelope" below is an OBSERVED SPAN ENVELOPE, not proven run wall-clock. Do NOT change task granularity, reviewer ordering, or gate sequencing based on this.\n`);
  out.push(`\nSpans: ${r.spanCount} · source: \`${r.generatedFrom}\` · edgesInferred: ${r.edgesInferred} · includeLowConfidence: ${r.includeLowConfidence}\n`);
  out.push(`## Rollup (value · status)\n`);
  out.push(`| metric | value | status |`);
  out.push(`|---|---|---|`);
  if (R.wallClockMs) out.push(line("run wall-clock (observed boundaries)", R.wallClockMs));
  out.push(line("observed span envelope (NOT wall-clock)", R.observedSpanEnvelopeMs));
  out.push(line("aggregate agent (observed spans only)", R.aggregateAgentMs));
  out.push(`| ${R.criticalPath.field} (${R.criticalPath.edgesInferred ? "edges INFERRED" : "edges observed"}) | ${ms(R.criticalPath.value)} | \`${R.criticalPath.status}\` (${R.criticalPath.confidence ?? "n/a"}) |`);
  out.push(line("residual unobserved elapsed (NOT proven idle)", R.residualUnobservedElapsedMs));
  out.push(line("aggregate − critical (overlap)", R.aggregateMinusCriticalMs));
  out.push(`| rework findings | ${R.reworkFindings.value ?? "—"} | \`${R.reworkFindings.status}\` |`);
  out.push(`| adversarial-unique findings | ${R.adversarialUniqueFindings.value ?? "—"} | \`${R.adversarialUniqueFindings.status}\` |`);
  if (R.criticalPath.assumptions?.length) {
    out.push(`\n**Critical-path assumptions:**`);
    for (const a of R.criticalPath.assumptions) out.push(`- ${a}`);
  }
  out.push(`\n## Spans\n`);
  out.push(`| span | stage (class/conf) | task | dur | out tok | tool summed / union | model |`);
  out.push(`|---|---|---|---|---|---|---|`);
  for (const s of r.spans) {
    const dur = s.startedAtEpochMs != null && s.endedAtEpochMs != null ? ms(s.endedAtEpochMs - s.startedAtEpochMs) : "—";
    out.push(`| \`${s.spanId.slice(0, 10)}\` | ${s.stage} (${s.stageClass}/${s.stageConfidence ?? "—"}) | ${s.taskId ?? "—"} | ${dur} | ${s.outputTokens} | ${s.summedToolMs}/${s.unionElapsedToolMs}ms | ${s.model ?? "—"} |`);
  }
  out.push(`\n## Known unknowns\n`);
  for (const u of r.knownUnknowns) out.push(`- ${u}`);
  out.push(`\n## Coverage\n\`\`\`json\n${JSON.stringify(r.coverage, null, 2)}\n\`\`\``);
  return out.join("\n");
}

// ---- CLI ----
function parseArgs(argv) {
  const a = { edgesObserved: false, provenance: "historical" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") a.subagentsDir = argv[++i];
    else if (argv[i] === "--run") a.runId = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--observed") a.edgesObserved = true;
  }
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.subagentsDir) { console.error("usage: analyze.mjs --dir <subagents_dir> [--run id] [--out prefix] [--observed]"); process.exit(2); }
  const report = analyzeRun(args);
  const prefix = args.out || `sdd-timing.${report.runId}`;
  writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${prefix}.md`, renderMarkdown(report));
  console.error(`wrote ${prefix}.json and ${prefix}.md (${report.spanCount} spans, label=${report.reportLabel})`);
}
