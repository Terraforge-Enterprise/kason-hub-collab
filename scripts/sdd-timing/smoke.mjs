#!/usr/bin/env node
// Observational SDD timing — end-to-end INSTRUMENTED SMOKE.
// Simulates one harmless SDD task through the real CLI (sdd-log.mjs) + the real gate
// wrapper (gate-run.mjs), then runs the real analyzer to produce an AUTHORITATIVE report.
// Proves the wiring end-to-end WITHOUT touching any controller/governing doc.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeForwardEvents } from "./analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "sdd-log.mjs");
const GATE = join(HERE, "gate-run.mjs");
const dir = mkdtempSync(join(tmpdir(), "sddsmoke-"));
const RUN = "smoke-run-1";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let overheadMs = 0, logCalls = 0;
function log(...args) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [LOG, ...args, "--run", RUN, "--events-dir", dir], { encoding: "utf8" });
  overheadMs += Number(process.hrtime.bigint() - t) / 1e6;
  logCalls++;
  if (r.status !== 0) console.error("  log FAILED", args.join(" "), r.stderr);
}
async function span(id, stage, parent, workMs, extra = []) {
  log("span-start", "--span", id, "--task", "task-1", "--stage", stage, ...(parent ? ["--parent", parent] : []), ...extra);
  await delay(workMs);
  log("span-end", "--span", id);
}

console.log(`instrumented smoke: run=${RUN} events=${dir}\n`);
log("run-start");
log("task-dispatch", "--task", "task-1");
await span("impl", "implement", null, 120, ["--model", "claude-opus-4-8", "--effort", "xhigh", "--fast", "true"]);
await span("rev-std", "review-standard", "impl", 80);
await span("rev-adv", "review-adversarial", "impl", 140);
await span("fix", "fix", "rev-adv", 60);
await span("rerev", "re-review", "fix", 60);
// integration gate: a span bracketing the REAL gate wrapper (harmless command)
log("span-start", "--span", "gate", "--task", "task-1", "--stage", "integration-gate", "--parent", "rerev");
const g = spawnSync(process.execPath, [GATE, "--sdd-events-dir", dir, "--sdd-run", RUN, "--sdd-gate-id", "gate-1", "--sdd-task", "task-1", "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8" });
log("span-end", "--span", "gate");
log("task-complete", "--task", "task-1");
await span("final", "final-review", "gate", 100);
log("run-end");

const rep = analyzeForwardEvents(dir, RUN);
const ms = (v) => (v == null ? "—" : `${v}ms`);
console.log("=== EVENT LIFECYCLE (assembled, in order) ===");
console.log(`  run boundaries: start=${rep.runStartEpochMs != null || rep.rollup.wallClockMs ? "observed" : "—"}  coverageComplete=${rep.forwardDataQuality ? "(see below)" : "?"}`);
console.log(`  gate exit (via wrapper): ${g.status}`);
console.log(`\n=== ROLLUP ===`);
console.log(`  provenance          : ${rep.provenance} (${rep.reportLabel})`);
console.log(`  wallClockMs         : ${ms(rep.rollup.wallClockMs?.value)}  [${rep.rollup.wallClockMs?.status}]`);
console.log(`  criticalPath        : ${ms(rep.rollup.criticalPath.value)}  field=${rep.rollup.criticalPath.field} [${rep.rollup.criticalPath.status}] edgesInferred=${rep.rollup.criticalPath.edgesInferred}`);
console.log(`  aggregateAgentMs    : ${ms(rep.rollup.aggregateAgentMs.value)}`);
console.log(`\n=== STAGE DURATIONS (observed edges) ===`);
for (const s of rep.spans) console.log(`  ${s.stage.padEnd(20)} ${ms(s.endedAtEpochMs - s.startedAtEpochMs).padStart(7)}  parent=${s.parentSpanId ?? "—"}  clock=${s.durationClock}  model=${s.model ?? "—"} effort=${s.effort ?? "—"} fast=${s.fastMode ?? "—"}`);
console.log(`\n=== GATE EVIDENCE ===`);
for (const gt of (rep.gates || [])) console.log(`  gate ${gt.gateId}: status=${gt.status} exit=${gt.exitCode} dur=${ms(gt.durationMs)} cmd="${gt.displayCommand}" commitMatch=${gt.commitMatch}`);
console.log(`\n=== INSTRUMENTATION OVERHEAD ===`);
console.log(`  sdd-log CLI calls   : ${logCalls}`);
console.log(`  total overhead      : ${overheadMs.toFixed(1)}ms  (${(overheadMs / logCalls).toFixed(1)}ms/call — node startup per event)`);
console.log(`\n=== COVERAGE / DATA QUALITY ===`);
console.log(`  ${JSON.stringify(rep.forwardDataQuality)}`);
console.log(`  coverageComplete    : ${rep.rollup.wallClockMs?.status === "authoritative"}`);
console.log(`\n=== KNOWN UNKNOWNS ===`);
for (const u of rep.knownUnknowns) console.log(`  - ${u}`);
