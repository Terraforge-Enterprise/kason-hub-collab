#!/usr/bin/env node
// Observational SDD timing — controller-side lifecycle event CLI.
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md §5.
//
// The SDD "controller" is an AGENT executing SKILL.md — there is no program to hook.
// This CLI is the concrete interface the controller invokes at stage boundaries to emit
// run/task/span lifecycle events (one process per event). It is OBSERVATIONAL and
// NON-BLOCKING: it never throws and always exits 0, so a logging failure can never fail
// the controller. (Per-event process invocation means span durations are epoch-derived
// across writers, not monotonic — the analyzer records durationClock accordingly.)
//
//   sdd-log.mjs <event> --run <id> --events-dir <dir> [flags]
//   events: run-start | run-end | coverage-interrupt | task-dispatch | task-complete
//           | task-failed | span-start | span-end
//   span-start flags: --span S --task T --stage STAGE [--parent P] [--deps "id1,id2"]
//                     [--model M] [--effort E] [--fast true|false]

import { RunLogger } from "./lib/forward-log.mjs";

function parse(argv) {
  const o = { _: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}
const bool = (v) => (v == null ? null : v === "true" ? true : v === "false" ? false : null);

const a = parse(process.argv.slice(2));
const eventsDir = a["events-dir"] || process.env.SDD_EVENTS_DIR;
const runId = a.run || process.env.SDD_RUN_ID;
if (!a._ || !eventsDir || !runId) {
  process.stderr.write("usage: sdd-log.mjs <event> --run <id> --events-dir <dir> [flags]\n");
  process.exit(2);
}

let logger;
try {
  logger = new RunLogger({ runId, eventsDir, instrumentationVersion: a.instr || "sdd-timing/1.0.0" });
} catch (e) {
  process.stderr.write(`[sdd-timing] sdd-log init failed: ${e && e.message}\n`);
  process.exit(0); // never fail the controller
}

const deps = a.deps ? a.deps.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
let ev = null;
switch (a._) {
  case "run-start": ev = logger.runStart({}); break;
  case "run-end": ev = logger.runEnd({}); break;
  case "coverage-interrupt": ev = logger.coverageInterrupt(a.reason || "abnormal termination"); break;
  case "task-dispatch": ev = logger.taskDispatch(a.task); break;
  case "task-complete": ev = logger.taskComplete(a.task); break;
  case "task-failed": ev = logger.emit("task-failed", { taskId: a.task, reason: a.reason || "failed" }); break;
  case "span-start":
    ev = logger.spanStart({
      spanId: a.span, taskId: a.task ?? null, stage: a.stage ?? "unknown",
      parentSpanId: a.parent ?? null, dependsOnSpanIds: deps,
      model: a.model ?? null, effort: a.effort ?? null, fastMode: bool(a.fast),
    });
    break;
  case "span-end": ev = logger.spanEnd({ spanId: a.span }); break;
  default:
    process.stderr.write(`[sdd-timing] unknown event: ${a._}\n`);
    process.exit(2);
}

// observational: emit the eventId (or nothing) and ALWAYS exit 0 — logging never blocks.
process.stdout.write((ev && ev.eventId) || "");
process.exit(0);
