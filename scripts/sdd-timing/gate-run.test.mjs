import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assembleRunFromEvents } from "./lib/forward-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "gate-run.mjs");
const FX = join(HERE, "fixtures", "gate");
const REPO = join(HERE, "..", ".."); // worktree root (a git repo) for commit-observation tests
const tmp = () => mkdtempSync(join(tmpdir(), "sddgate-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await delay(20); }
  return false;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Spawn the wrapper DETACHED so it is its own process-group leader; the test can then
// deliver a signal to the wrapper's GROUP (process.kill(-pid, sig)) — the faithful
// simulation of a terminal delivering Ctrl+C to the foreground process group.
function spawnWrapperGroup(childArgv, opt = {}) {
  const args = [GATE, "--sdd-events-dir", opt.eventsDir, "--sdd-run", opt.runId, "--sdd-gate-id", opt.gateId, ...(opt.extra || []), "--", ...childArgv];
  const w = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: opt.cwd || process.cwd() });
  let out = "", err = "";
  w.stdout.on("data", (d) => (out += d));
  w.stderr.on("data", (d) => (err += d));
  const done = new Promise((res) => w.on("close", (code, signal) => res({ code, signal, out, err })));
  return { w, done };
}

function runWrapper(childArgv, opt = {}) {
  return new Promise((resolve) => {
    const args = [GATE];
    if (opt.eventsDir) args.push("--sdd-events-dir", opt.eventsDir);
    if (opt.runId) args.push("--sdd-run", opt.runId);
    if (opt.gateId) args.push("--sdd-gate-id", opt.gateId);
    if (opt.extra) args.push(...opt.extra);
    args.push("--", ...childArgv);
    const w = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opt.env || process.env,
      cwd: opt.cwd || process.cwd(),
    });
    let out = "", err = "";
    w.stdout.on("data", (d) => (out += d));
    w.stderr.on("data", (d) => (err += d));
    if (opt.signal) setTimeout(() => { try { w.kill(opt.signal); } catch { /* gone */ } }, opt.delay ?? 300);
    w.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}
const gateOf = (eventsDir, runId, gateId) => assembleRunFromEvents(eventsDir, runId).gates.find((g) => g.gateId === gateId);

// ---------- exit-code / signal equivalence ----------
test("exit 0 → wrapper exits 0; gate-end complete", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, "-e", "process.exit(0)"], { eventsDir, runId: "e0", gateId: "g" });
  assert.equal(r.code, 0);
  const g = gateOf(eventsDir, "e0", "g");
  assert.equal(g.status, "complete");
  assert.equal(g.exitCode, 0);
});

test("exit 3 → wrapper exits 3 (exact code preserved)", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, "-e", "process.exit(3)"], { eventsDir, runId: "e3", gateId: "g" });
  assert.equal(r.code, 3);
  assert.equal(gateOf(eventsDir, "e3", "g").exitCode, 3);
});

test("SIGTERM → wrapper exits 143; gate-interrupted records SIGTERM", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, "-e", "setInterval(()=>{},1000)"],
    { eventsDir, runId: "t", gateId: "g", signal: "SIGTERM", delay: 300 });
  assert.equal(r.code, 143); // 128 + 15, matches the shell baseline
  const g = gateOf(eventsDir, "t", "g");
  assert.equal(g.status, "interrupted");
  assert.equal(g.terminatingSignal, "SIGTERM");
});

test("SIGINT → wrapper exits 130; gate-interrupted records SIGINT", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, "-e", "setInterval(()=>{},1000)"],
    { eventsDir, runId: "i", gateId: "g", signal: "SIGINT", delay: 300 });
  assert.equal(r.code, 130); // 128 + 2
  assert.equal(gateOf(eventsDir, "i", "g").terminatingSignal, "SIGINT");
});

test("command not found → wrapper exits 127; spawnError recorded", async () => {
  const eventsDir = tmp();
  const r = await runWrapper(["definitely_no_such_cmd_zzz123"], { eventsDir, runId: "nf", gateId: "g" });
  assert.equal(r.code, 127);
  assert.equal(gateOf(eventsDir, "nf", "g").exitCode, 127);
});

// ---------- instrumentation must never change gate truth ----------
test("logger dir unwritable → gate truth preserved (exit 0), but NOT silent", async () => {
  const base = tmp();
  const asFile = join(base, "not-a-dir");
  writeFileSync(asFile, "x"); // events-dir points at a FILE → logger cannot write
  const r = await runWrapper([process.execPath, "-e", "process.exit(0)"], { eventsDir: asFile, runId: "u", gateId: "g" });
  assert.equal(r.code, 0);                       // instrumentation failure did NOT flip the gate
  assert.ok(/\[sdd-timing/.test(r.err));         // but a warning was emitted (non-blocking != silent)
});

test("logger dir unwritable → a FAILING gate stays failing (exit 5 preserved)", async () => {
  const base = tmp();
  const asFile = join(base, "nd");
  writeFileSync(asFile, "x");
  const r = await runWrapper([process.execPath, "-e", "process.exit(5)"], { eventsDir: asFile, runId: "u2", gateId: "g" });
  assert.equal(r.code, 5); // logger/FS failure cannot turn a failure into success or vice versa
});

// ---------- argv / env / cwd / stdio fidelity ----------
test("argv preserved exactly: spaces, quotes, glob chars, empty string", async () => {
  const eventsDir = tmp();
  const weird = ["a b", 'c"d', "*.nomatch", "", "$HOME"];
  const r = await runWrapper([process.execPath, join(FX, "echo-argv.mjs"), ...weird], { eventsDir, runId: "a", gateId: "g" });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), weird); // no glob expansion, empties kept, no $HOME expansion
});

test("environment + working directory reach the child unchanged", async () => {
  const eventsDir = tmp();
  const cwd = tmp();
  const r = await runWrapper([process.execPath, join(FX, "echo-env-cwd.mjs")],
    { eventsDir, runId: "ec", gateId: "g", env: { ...process.env, SDD_TEST_VAR: "hello" }, cwd });
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.v, "hello");
  assert.equal(parsed.cwd, realpathSync(cwd)); // child reports realpath (macOS /var→/private/var)
});

test("stdout AND stderr stream through live (not captured/altered)", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, join(FX, "echo-streams.mjs")], { eventsDir, runId: "s", gateId: "g" });
  assert.ok(r.out.includes("OUT:hello"));
  assert.ok(r.err.includes("ERR:world"));
});

// ---------- gate assembly flags (analyzer side) ----------
const ev = (o) => JSON.stringify({ schemaVersion: "1.0.0", instrumentationVersion: "t", runId: "r", writerId: "w", ...o });
function raw(dir, runId, lines) {
  mkdirSync(join(dir, runId), { recursive: true });
  writeFileSync(join(dir, runId, "w.jsonl"), lines.join("\n") + "\n");
}

test("gate assembly: missing gate-end → gateIssue, coverage incomplete", () => {
  const dir = tmp();
  raw(dir, "gm", [
    ev({ eventId: "R0", type: "run-start", seq: 0, epochMs: 1, monoNs: "0" }),
    ev({ eventId: "GS", type: "gate-start", gateId: "g1", argv: ["npm", "test"], seq: 1, epochMs: 2, monoNs: "0" }),
    ev({ eventId: "R1", type: "run-end", seq: 2, epochMs: 9, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "gm");
  assert.ok(run.dataQuality.gateIssues.some((i) => /missing gate-end/i.test(i)));
  assert.equal(run.coverageComplete, false);
  assert.equal(run.gates[0].status, "incomplete");
});

test("gate assembly: intended != OBSERVED HEAD → mismatch issue; match only from observed", () => {
  const dir = tmp();
  raw(dir, "gc", [
    ev({ eventId: "GS", type: "gate-start", gateId: "g1", argv: ["npm", "test"], intendedGateCommit: "def", observedGateCommitBefore: "abc", commitObsProvenance: "git rev-parse HEAD", seq: 0, epochMs: 1, monoNs: "0" }),
    ev({ eventId: "GE", type: "gate-end", gateId: "g1", exitCode: 0, observedGateCommitAfter: "abc", seq: 1, epochMs: 2, monoNs: "1000000" }),
  ]);
  const run = assembleRunFromEvents(dir, "gc");
  assert.ok(run.dataQuality.gateIssues.some((i) => /intended commit def != observed HEAD abc/i.test(i)));
  assert.equal(run.gates[0].commitMatch, "mismatch");
});

test("gate assembly: intended === observed → matched (asserted from observed value)", () => {
  const dir = tmp();
  raw(dir, "gm2", [
    ev({ eventId: "GS", type: "gate-start", gateId: "g1", argv: ["x"], intendedGateCommit: "abc", observedGateCommitBefore: "abc", seq: 0, epochMs: 1, monoNs: "0" }),
    ev({ eventId: "GE", type: "gate-end", gateId: "g1", exitCode: 0, observedGateCommitAfter: "abc", seq: 1, epochMs: 2, monoNs: "0" }),
  ]);
  assert.equal(assembleRunFromEvents(dir, "gm2").gates[0].commitMatch, "matched");
});

test("gate assembly: controller value alone (observed null) is NOT 'matched'", () => {
  const dir = tmp();
  raw(dir, "gu", [
    ev({ eventId: "GS", type: "gate-start", gateId: "g1", argv: ["x"], intendedGateCommit: "abc", observedGateCommitBefore: null, commitObsProvenance: "git rev-parse HEAD failed: not a git repo", seq: 0, epochMs: 1, monoNs: "0" }),
    ev({ eventId: "GE", type: "gate-end", gateId: "g1", exitCode: 0, seq: 1, epochMs: 2, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "gu");
  assert.equal(run.gates[0].commitMatch, "unknown");                // never "matched" from claim alone
  assert.ok(run.dataQuality.gateIssues.some((i) => /could not observe repo commit/i.test(i)));
});

test("gate assembly: observed HEAD changed DURING gate → flagged", () => {
  const dir = tmp();
  raw(dir, "gch", [
    ev({ eventId: "GS", type: "gate-start", gateId: "g1", argv: ["x"], observedGateCommitBefore: "aaa", seq: 0, epochMs: 1, monoNs: "0" }),
    ev({ eventId: "GE", type: "gate-end", gateId: "g1", exitCode: 0, observedGateCommitAfter: "bbb", seq: 1, epochMs: 2, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "gch");
  assert.ok(run.dataQuality.gateIssues.some((i) => /observed HEAD changed during gate/i.test(i)));
  assert.equal(run.gates[0].observedChangedDuringGate, true);
});

test("gate assembly: dirty worktree is a WARNING, not a hard issue (does not force incomplete)", () => {
  const dir = tmp();
  raw(dir, "gd", [
    ev({ eventId: "R0", type: "run-start", seq: 0, epochMs: 1, monoNs: "0" }),
    ev({ eventId: "GS", type: "gate-start", gateId: "g1", argv: ["x"], observedGateCommitBefore: "aaa", dirtyWorktreeBefore: true, seq: 1, epochMs: 2, monoNs: "0" }),
    ev({ eventId: "GE", type: "gate-end", gateId: "g1", exitCode: 0, observedGateCommitAfter: "aaa", seq: 2, epochMs: 3, monoNs: "0" }),
    ev({ eventId: "R1", type: "run-end", seq: 3, epochMs: 9, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "gd");
  assert.equal(run.gates[0].dirtyWorktree, true);
  assert.ok(run.dataQuality.gateWarnings.some((w) => /worktree dirty/i.test(w)));
  assert.deepEqual(run.dataQuality.gateIssues, []);  // dirty alone is not a hard issue
  assert.equal(run.coverageComplete, true);          // ...so coverage stays complete
});

test("gate assembly: gate-end with no matching gate-start → mismatched ID flagged", () => {
  const dir = tmp();
  raw(dir, "gx", [
    ev({ eventId: "GE", type: "gate-end", gateId: "ghost", exitCode: 0, seq: 0, epochMs: 1, monoNs: "0" }),
  ]);
  const run = assembleRunFromEvents(dir, "gx");
  assert.ok(run.dataQuality.gateIssues.some((i) => /gate-end without gate-start/i.test(i)));
});

// ---------- process-group signal model (terminal-faithful) ----------
test("terminal-group SIGINT reaches the child EXACTLY ONCE (no double-delivery)", async () => {
  const dir = tmp();
  const { w, done } = spawnWrapperGroup([process.execPath, join(FX, "sig-counter.mjs"), dir], { eventsDir: tmp(), runId: "sd", gateId: "g" });
  assert.ok(await waitFor(() => existsSync(join(dir, "ready"))), "child should signal ready");
  process.kill(-w.pid, "SIGINT"); // deliver to the wrapper's process GROUP == terminal Ctrl+C
  await done;
  assert.equal(readFileSync(join(dir, "count"), "utf8"), "1"); // exactly one delivery, not two
});

test("no orphaned descendants: group SIGTERM tears down the whole npm→runner→worker tree", async () => {
  const dir = tmp();
  const { w, done } = spawnWrapperGroup([process.execPath, join(FX, "tree.mjs"), dir, "0"], { eventsDir: tmp(), runId: "tr", gateId: "g" });
  assert.ok(await waitFor(() => [0, 1, 2].every((d) => existsSync(join(dir, `pid-${d}`)))), "3-level tree should spawn");
  const pids = [0, 1, 2].map((d) => Number(readFileSync(join(dir, `pid-${d}`), "utf8")));
  process.kill(-w.pid, "SIGTERM");
  const r = await done;
  assert.equal(r.code, 143); // 128 + SIGTERM
  await waitFor(() => pids.every((p) => !alive(p)), 3000);
  for (const p of pids) assert.equal(alive(p), false, `pid ${p} must be dead (no orphan)`);
});

// ---------- wrapper-observed commit vs controller-intended commit ----------
test("wrapper OBSERVES HEAD: bogus intended != observed → mismatch (real git repo)", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, "-e", "process.exit(0)"],
    { eventsDir, runId: "ci", gateId: "g", extra: ["--sdd-intended-commit", "0".repeat(40)], cwd: REPO });
  assert.equal(r.code, 0);
  const g = assembleRunFromEvents(eventsDir, "ci").gates[0];
  assert.equal(g.commitObservable, true);   // the wrapper actually read HEAD
  assert.equal(g.commitMatch, "mismatch");
  assert.notEqual(g.observedGateCommit, null);
});

test("wrapper OBSERVES HEAD: intended === real HEAD → matched (from observed value)", async () => {
  const eventsDir = tmp();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const r = await runWrapper([process.execPath, "-e", "process.exit(0)"],
    { eventsDir, runId: "cm", gateId: "g", extra: ["--sdd-intended-commit", head], cwd: REPO });
  assert.equal(r.code, 0);
  const g = assembleRunFromEvents(eventsDir, "cm").gates[0];
  assert.equal(g.observedGateCommit, head);
  assert.equal(g.commitMatch, "matched");
});

test("wrapper commit observation fails gracefully in a NON-git dir (null + provenance, gate truth intact)", async () => {
  const eventsDir = tmp();
  const r = await runWrapper([process.execPath, "-e", "process.exit(0)"],
    { eventsDir, runId: "ng", gateId: "g", extra: ["--sdd-intended-commit", "abc"], cwd: tmp() });
  assert.equal(r.code, 0); // git failure does not change the gate result
  const g = assembleRunFromEvents(eventsDir, "ng").gates[0];
  assert.equal(g.observedGateCommit, null);
  assert.equal(g.commitObservable, false);
  assert.match(g.commitObsProvenance, /git rev-parse HEAD failed/);
  assert.equal(g.commitMatch, "unknown");
});
