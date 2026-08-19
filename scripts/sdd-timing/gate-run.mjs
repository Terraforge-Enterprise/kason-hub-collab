#!/usr/bin/env node
// Observational SDD timing — GATE WRAPPER (supervising parent; never exec).
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md §6.
//
// PROCESS / SIGNAL MODEL (verified experimentally):
//   - We SPAWN the child (never exec) so the wrapper survives to observe/log it.
//   - The child runs in its OWN process group (detached:true). A terminal therefore
//     delivers Ctrl+C/SIGINT to the WRAPPER's foreground group only, NOT the child —
//     so there is no automatic double-delivery. The wrapper forwards the received
//     signal to the child's group exactly ONCE (process.kill(-pgid, sig)), which also
//     reaches the whole child tree (npm → runner → worker) so nothing is orphaned.
//   - stdio:"inherit" — output streams live, never captured; cwd + env inherited;
//     argv passed as an ARRAY (no shell, no glob, empty strings preserved).
//   - TERMINATION CONTRACT: the wrapper NORMALISES signal death to a normal exit with
//     status 128+signal (SIGTERM→143, SIGINT→130). It exits normally with that code;
//     it does NOT re-raise the signal, so a waitpid() caller sees WIFEXITED(128+sig),
//     not WIFSIGNALED(sig). For a shell, `$?` is identical to the unwrapped command.
//     ENOENT→127, EACCES→126, plain exit code C→C.
//   - Instrumentation is best-effort and NEVER changes gate truth: a logger/FS/git
//     failure warns to stderr but the exit status is always the child's real result.

import { spawn, execFileSync } from "node:child_process";
import os from "node:os";
import { RunLogger } from "./lib/forward-log.mjs";

const INSTRUMENTATION_VERSION = "sdd-timing/1.0.0";

function parseArgs(argv) {
  const o = { events: null, runId: null, gateId: null, taskId: null, intendedGateCommit: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { i++; break; }
    else if (a === "--sdd-events-dir") o.events = argv[++i];
    else if (a === "--sdd-run") o.runId = argv[++i];
    else if (a === "--sdd-gate-id") o.gateId = argv[++i];
    else if (a === "--sdd-task") o.taskId = argv[++i];
    else if (a === "--sdd-intended-commit") o.intendedGateCommit = argv[++i];
    else { return { error: `unknown wrapper option before --: ${a}` }; }
  }
  o.childArgv = argv.slice(i);
  return o;
}

function displayCommand(argv) {
  return argv.map((a) => (a === "" ? "''" : /[\s"'`$*?~|&;<>(){}\[\]\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
}

// best-effort repository observation; never throws (returns provenance on failure)
function observeCommit(cwd) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { commit: commit || null, provenance: commit ? "git rev-parse HEAD" : "git rev-parse HEAD returned empty" };
  } catch (e) {
    return { commit: null, provenance: `git rev-parse HEAD failed: ${String(e && e.message || e).slice(0, 60)}` };
  }
}
function observeDirty(cwd) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.trim().length > 0;
  } catch { return null; } // null = could not determine
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error || !opts.childArgv || opts.childArgv.length === 0) {
    process.stderr.write(`[sdd-timing gate-run] ${opts.error || "no command after --"}\n` +
      `usage: gate-run.mjs --sdd-events-dir <dir> --sdd-run <id> --sdd-gate-id <id> [--sdd-task <id>] [--sdd-intended-commit <sha>] -- <command> [args...]\n`);
    process.exit(2);
    return;
  }
  const childArgv = opts.childArgv;
  const cwd = process.cwd();

  let logger = null;
  try { if (opts.events && opts.runId) logger = new RunLogger({ runId: opts.runId, eventsDir: opts.events, instrumentationVersion: INSTRUMENTATION_VERSION }); }
  catch (e) { process.stderr.write(`[sdd-timing gate-run] logger init failed: ${e && e.message}\n`); }
  const emit = (type, fields) => { try { if (logger) logger.emit(type, fields); } catch (e) { process.stderr.write(`[sdd-timing gate-run] event ${type} failed: ${e && e.message}\n`); } };

  const before = observeCommit(cwd);
  emit("gate-start", {
    gateId: opts.gateId, taskId: opts.taskId,
    argv: childArgv, displayCommand: displayCommand(childArgv), cwd,
    intendedGateCommit: opts.intendedGateCommit,
    observedGateCommitBefore: before.commit,
    commitObsProvenance: before.provenance,
    dirtyWorktreeBefore: observeDirty(cwd),
  });

  let finished = false;
  const finalize = (status) => { if (finished) return; finished = true; process.exit(status); };

  // Child in its OWN process group so terminal signals do not double-deliver.
  const child = spawn(childArgv[0], childArgv.slice(1), { stdio: "inherit", cwd, env: process.env, detached: true });

  // forward a received signal to the child's process GROUP exactly once
  const forward = (sig) => {
    try { process.kill(-child.pid, sig); }        // negative pid = process group (whole tree)
    catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => forward(sig));

  const endFields = () => ({
    gateId: opts.gateId,
    observedGateCommitAfter: observeCommit(cwd).commit,
    dirtyWorktreeAfter: observeDirty(cwd),
    testCount: null, testCountProvenance: "not-captured: stdio inherited; no machine-readable source", cacheReported: null,
  });

  child.on("error", (err) => {
    const exitCode = err && err.code === "EACCES" ? 126 : 127;
    emit("gate-end", { ...endFields(), exitCode, terminatingSignal: null, spawnError: err && err.code });
    finalize(exitCode);
  });
  child.on("close", (code, signal) => {
    if (signal) {
      const exitCode = 128 + (os.constants.signals[signal] || 0);
      emit("gate-interrupted", { ...endFields(), terminatingSignal: signal, exitCode });
      finalize(exitCode);
    } else {
      emit("gate-end", { ...endFields(), exitCode: code, terminatingSignal: null });
      finalize(code == null ? 0 : code);
    }
  });
}

main();
