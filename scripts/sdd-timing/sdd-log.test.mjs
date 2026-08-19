import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleRunFromEvents } from "./lib/forward-log.mjs";

const LOG = join(dirname(fileURLToPath(import.meta.url)), "sdd-log.mjs");
const tmp = () => mkdtempSync(join(tmpdir(), "sddlog-"));
const run = (args, dir, runId = "r") => spawnSync(process.execPath, [LOG, ...args, "--run", runId, "--events-dir", dir], { encoding: "utf8" });

test("emits a valid run-start (exit 0, assembles run boundary)", () => {
  const dir = tmp();
  assert.equal(run(["run-start"], dir).status, 0);
  assert.notEqual(assembleRunFromEvents(dir, "r").runStartEpochMs, null);
});

test("span-start carries parent + model/effort/fast; span-end pairs by spanId (observed edge)", () => {
  const dir = tmp();
  run(["run-start"], dir);
  run(["span-start", "--span", "impl", "--task", "t1", "--stage", "implement", "--model", "claude-opus-4-8", "--effort", "xhigh", "--fast", "true"], dir);
  run(["span-end", "--span", "impl"], dir);
  run(["span-start", "--span", "rev", "--task", "t1", "--stage", "review-standard", "--parent", "impl"], dir);
  run(["span-end", "--span", "rev"], dir);
  run(["run-end"], dir);
  const asm = assembleRunFromEvents(dir, "r");
  const impl = asm.spans.find((s) => s.spanId === "impl");
  const rev = asm.spans.find((s) => s.spanId === "rev");
  assert.equal(impl.stage, "implement");
  assert.equal(impl.stageClass, "observed");
  assert.equal(impl.model, "claude-opus-4-8");
  assert.equal(impl.effort, "xhigh");
  assert.equal(impl.fastMode, true);
  assert.equal(rev.parentSpanId, "impl"); // observed dependency edge preserved
});

test("task-failed marks coverage incomplete (task lifecycle)", () => {
  const dir = tmp();
  run(["run-start"], dir);
  run(["task-dispatch", "--task", "t1"], dir);
  run(["task-failed", "--task", "t1", "--reason", "boom"], dir);
  run(["run-end"], dir);
  const asm = assembleRunFromEvents(dir, "r");
  assert.equal(asm.coverageComplete, false);
  assert.ok(asm.dataQuality.interrupts.some((i) => /task t1 failed: boom/.test(i)));
});

test("unknown event / missing required args → exit 2 (never a silent no-op)", () => {
  assert.equal(run(["bogus-event"], tmp()).status, 2);
  assert.equal(spawnSync(process.execPath, [LOG, "run-start"], { encoding: "utf8" }).status, 2); // no --run/--events-dir
});
