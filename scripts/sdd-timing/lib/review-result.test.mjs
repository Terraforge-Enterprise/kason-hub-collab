import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildReviewResult, validateReviewResult, writeReviewResult, readReviewResult, validateReworkLink,
  compositeFindingId, isSafeId,
} from "./review-result.mjs";

function runWorker(dir, variant, spanId) {
  return new Promise((res) => {
    const w = spawn(process.execPath, [join(FIX, "concurrent-writer.mjs"), dir, variant, spanId], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    w.stdout.on("data", (d) => (out += d));
    w.on("close", () => { try { res(JSON.parse(out || "{}")); } catch { res({ ok: false, parseError: out }); } });
  });
}

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "review");
const tmp = () => mkdtempSync(join(tmpdir(), "sddrev-"));

const GOLDEN_INPUT = {
  runId: "run-1", taskId: "task-7", reviewSpanId: "rev-adv-7", reviewerRole: "adversarial",
  reviewedBaseCommit: "aaa111", reviewedHeadCommit: "bbb222", outcome: "changes-requested",
  findings: [
    { findingId: "F1", severity: "high", category: "money", summary: "SST rounding off by 0.01", file: "apps/api/src/modules/owner-billing/service.ts", line: 212, reviewerClaimedNewlyDiscovered: true, duplicateOfFindingId: null, relatedFindingIds: ["F2"] },
    { findingId: "F2", severity: "low", category: "style", summary: "naming nit", file: "apps/api/src/x.ts", line: 5, reviewerClaimedNewlyDiscovered: false, duplicateOfFindingId: null, relatedFindingIds: [] },
  ],
};
const build = (over = {}, now = 1784500000000) => buildReviewResult({ ...GOLDEN_INPUT, ...over }, { now });

// ---------------- validation ----------------
test("valid: clean review with ZERO findings", () => {
  const art = build({ outcome: "clean", findings: [] });
  const v = validateReviewResult(art);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("valid: review with multiple findings + related ref", () => {
  assert.equal(validateReviewResult(build()).valid, true);
});

test("invalid: missing required identifier (reviewSpanId)", () => {
  const art = build();
  delete art.reviewSpanId;
  const v = validateReviewResult(art);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /missing required field: reviewSpanId/.test(e)));
});

test("invalid: duplicate findingId within one artifact", () => {
  const art = build({ findings: [
    { findingId: "D", severity: "low", category: "style" },
    { findingId: "D", severity: "high", category: "money" },
  ] });
  assert.ok(validateReviewResult(art).errors.some((e) => /duplicate findingId: D/.test(e)));
});

test("invalid: malformed references (self-dup, self-related, dup-related, mutual-dup)", () => {
  assert.ok(validateReviewResult(build({ findings: [{ findingId: "A", severity: "low", category: "style", duplicateOfFindingId: "A" }] })).errors.some((e) => /self-referencing duplicateOfFindingId/.test(e)));
  assert.ok(validateReviewResult(build({ findings: [{ findingId: "A", severity: "low", category: "style", relatedFindingIds: ["A"] }] })).errors.some((e) => /relatedFindingIds self-reference/.test(e)));
  assert.ok(validateReviewResult(build({ findings: [{ findingId: "A", severity: "low", category: "style", relatedFindingIds: ["B", "B"] }] })).errors.some((e) => /duplicate relatedFindingIds/.test(e)));
  const mutual = build({ findings: [
    { findingId: "A", severity: "low", category: "style", duplicateOfFindingId: "B" },
    { findingId: "B", severity: "low", category: "style", duplicateOfFindingId: "A" },
  ] });
  assert.ok(validateReviewResult(mutual).errors.some((e) => /contradictory mutual duplication/.test(e)));
});

test("invalid: malformed severity / category / outcome / reviewerRole enums", () => {
  assert.ok(validateReviewResult(build({ findings: [{ findingId: "A", severity: "SEV-X", category: "money" }] })).errors.some((e) => /invalid severity enum/.test(e)));
  assert.ok(validateReviewResult(build({ findings: [{ findingId: "A", severity: "low", category: "nope" }] })).errors.some((e) => /invalid category enum/.test(e)));
  assert.ok(validateReviewResult(build({ outcome: "approved" })).errors.some((e) => /invalid outcome enum/.test(e)));
  assert.ok(validateReviewResult(build({ reviewerRole: "boss" })).errors.some((e) => /invalid reviewerRole/.test(e)));
});

test("unresolved cross-review reference is preserved, NOT an error", () => {
  const art = build({ findings: [{ findingId: "A", severity: "low", category: "style", duplicateOfFindingId: "FROM-EARLIER-REVIEW", relatedFindingIds: ["ALSO-ELSEWHERE"] }] });
  const v = validateReviewResult(art);
  assert.equal(v.valid, true);
  assert.equal(v.unresolvedReferences.length, 2);
  assert.ok(v.unresolvedReferences.some((r) => r.kind === "duplicateOf" && r.ref === "FROM-EARLIER-REVIEW"));
});

test("invalid: a finding whose reviewSpanId belongs to ANOTHER review", () => {
  const art = build({ findings: [{ findingId: "A", reviewSpanId: "some-other-review", severity: "low", category: "style" }] });
  assert.ok(validateReviewResult(art).errors.some((e) => /belongs to another review/.test(e)));
});

test("AUTHORITY BOUNDARY: reworkOfFindingIds is rejected in a ReviewResult (top-level AND per-finding)", () => {
  // NB: buildReviewResult normalises findings (strips unknown fields), so we inject the
  // controller-owned field into a raw artifact to exercise the VALIDATOR directly.
  const top = build(); top.reworkOfFindingIds = ["F1"];
  assert.ok(validateReviewResult(top).errors.some((e) => /reworkOfFindingIds is controller-owned/.test(e)));
  const perF = build(); perF.findings[0].reworkOfFindingIds = ["X"];
  assert.ok(validateReviewResult(perF).errors.some((e) => /reworkOfFindingIds is controller-owned/.test(e)));
});

test("invalid: unknown fields rejected under strict (top-level + finding)", () => {
  const t = build(); t.mysteryField = 1;
  assert.ok(validateReviewResult(t).errors.some((e) => /unknown top-level field: mysteryField/.test(e)));
  const f = build(); f.findings[0].adversarialUnique = true; // an authoritative-conclusion field must not sneak in
  assert.ok(validateReviewResult(f).errors.some((e) => /unknown field: adversarialUnique/.test(e)));
});

test("invalid: unknown schema version", () => {
  const art = build(); art.schemaVersion = "9.9.9";
  assert.ok(validateReviewResult(art).errors.some((e) => /unknown\/unsupported schemaVersion/.test(e)));
});

// ---------------- build / determinism / golden ----------------
test("build: deterministic id (content hash), defaults filled, commit ranges not inferred", () => {
  const a = build({}, 1000), b = build({}, 2000);
  assert.match(a.artifactId, /^[0-9a-f]{64}$/);
  assert.equal(a.artifactId, b.artifactId);                       // id excludes volatile timestamp
  assert.equal(a.findings[0].reviewSpanId, "rev-adv-7");          // provenance set
  assert.equal(a.findings[1].reviewerClaimedNewlyDiscovered, false); // claim default
  const noCommits = buildReviewResult({ ...GOLDEN_INPUT, reviewedBaseCommit: undefined, reviewedHeadCommit: undefined }, { now: 1 });
  assert.equal(noCommits.reviewedBaseCommit, null);              // null, never inferred
});

test("golden: build matches committed golden.json byte-for-byte", () => {
  const golden = JSON.parse(readFileSync(join(FIX, "golden.json"), "utf8"));
  assert.deepEqual(build(), golden);
  assert.equal(validateReviewResult(golden).valid, true);
});

// ---------------- write / read / atomic / idempotency ----------------
test("write: valid → atomic publish, readback valid, no temp left behind", () => {
  const dir = tmp();
  const res = writeReviewResult(dir, build());
  assert.equal(res.ok, true);
  assert.ok(existsSync(res.path));
  assert.equal(readReviewResult(dir, "rev-adv-7").ok, true);
  assert.equal(readdirSync(dir).filter((f) => f.includes(".tmp")).length, 0); // no partial temp
});

test("idempotent retry: identical content (different timestamp) → idempotent, not conflict", () => {
  const dir = tmp();
  assert.equal(writeReviewResult(dir, build({}, 1000)).ok, true);
  const retry = writeReviewResult(dir, build({}, 9999)); // only generatedAtEpochMs differs
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
});

test("conflict: differing content for same reviewSpanId → refused (no accidental overwrite)", () => {
  const dir = tmp();
  assert.equal(writeReviewResult(dir, build()).ok, true);
  const conflict = writeReviewResult(dir, build({ outcome: "clean", findings: [] }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "conflict");
});

test("write refuses an INVALID artifact (nothing published)", () => {
  const dir = tmp();
  const bad = build(); bad.outcome = "approved";
  const res = writeReviewResult(dir, bad);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid");
  assert.equal(existsSync(join(dir, "review-rev-adv-7.json")), false);
});

test("unwritable directory → io-error, gate/review outcome untouched", () => {
  const base = tmp();
  const asFile = join(base, "not-a-dir");
  writeFileSync(asFile, "x");
  const res = writeReviewResult(asFile, build());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "io-error");
});

test("read: missing artifact", () => {
  assert.deepEqual(readReviewResult(tmp(), "nope").reason, "missing");
});

test("read: corrupted JSON", () => {
  const dir = tmp();
  writeFileSync(join(dir, "review-x.json"), "{ this is not json");
  const res = readReviewResult(dir, "x");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "corrupted-json");
});

// ---------------- rework link (separate controller-owned surface) ----------------
test("ReworkLink: reworkOfFindingIds is valid HERE (its proper home), strict-checked", () => {
  const link = { schemaVersion: "1.0.0", runId: "r", taskId: "t", fixSpanId: "fix-1", reworkOfFindingIds: ["F1", "F2"], generatedAtEpochMs: 1, artifactId: "a" };
  assert.equal(validateReworkLink(link).valid, true);
  const missing = { ...link }; delete missing.reworkOfFindingIds;
  assert.ok(validateReworkLink(missing).errors.some((e) => /missing required field: reworkOfFindingIds/.test(e)));
  const unknown = { ...link, findings: [] }; // reviewer findings do NOT belong here
  assert.ok(validateReworkLink(unknown).errors.some((e) => /unknown field: findings/.test(e)));
});

// ---------------- concurrent publication (real multi-process) ----------------
test("CONCURRENT identical writers → idempotent, exactly one artifact, no temp litter", async () => {
  const dir = tmp();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => runWorker(dir, "same", "rev-c")));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(results.filter((r) => !r.idempotent).length, 1); // exactly one creator; the rest resolve idempotently
  const files = readdirSync(dir);
  assert.equal(files.filter((f) => f === "review-rev-c.json").length, 1); // exactly one authoritative artifact
  assert.equal(files.filter((f) => f.includes(".tmp")).length, 0);        // no abandoned temp files
  assert.equal(readReviewResult(dir, "rev-c").ok, true);
});

test("CONCURRENT conflicting writers → exactly one wins, others refused, no clobber/temp", async () => {
  const dir = tmp();
  const results = await Promise.all(["1", "2", "3", "4", "5"].map((v) => runWorker(dir, v, "rev-x")));
  assert.equal(results.filter((r) => r.ok && !r.idempotent).length, 1);              // one authoritative winner
  assert.equal(results.filter((r) => !r.ok && r.reason === "conflict").length, 4);   // the rest never clobber it
  const files = readdirSync(dir);
  assert.equal(files.filter((f) => f === "review-rev-x.json").length, 1);
  assert.equal(files.filter((f) => f.includes(".tmp")).length, 0);
  assert.equal(readReviewResult(dir, "rev-x").ok, true);
});

// ---------------- path safety ----------------
test("path safety: unsafe reviewSpanId/runId/taskId rejected BEFORE fs access", () => {
  for (const bad of ["../evil", "a/b", "..", ".", "x y", "c\ncontrol", "z".repeat(200)]) {
    const v = validateReviewResult(build({ reviewSpanId: bad }));
    assert.equal(v.valid, false, `reviewSpanId ${JSON.stringify(bad)} should be invalid`);
    assert.ok(v.errors.some((e) => /unsafe reviewSpanId/.test(e)));
  }
  assert.ok(validateReviewResult(build({ runId: "../x" })).errors.some((e) => /unsafe runId/.test(e)));
  assert.ok(validateReviewResult(build({ taskId: "a/b" })).errors.some((e) => /unsafe taskId/.test(e)));
  assert.equal(isSafeId("a679862c5b9963b8b"), true);  // real agentId-style ids are fine
  assert.equal(isSafeId(".."), false);
});

test("write refuses an unsafe reviewSpanId without escaping the directory", () => {
  const dir = tmp();
  const res = writeReviewResult(dir, build({ reviewSpanId: "../escape" }));
  assert.equal(res.ok, false);
  assert.ok(["invalid", "unsafe-id"].includes(res.reason));
  assert.equal(readdirSync(dir).length, 0); // nothing written anywhere
});

// ---------------- cross-field invariants ----------------
test("cross-field: 'clean' with a blocking (high/critical) finding is contradictory", () => {
  const v = validateReviewResult(build({ outcome: "clean" })); // GOLDEN carries an F1 'high' finding
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /outcome 'clean' contradicts .* blocking/.test(e)));
});

test("cross-field: 'changes-requested' with zero findings is contradictory", () => {
  assert.ok(validateReviewResult(build({ outcome: "changes-requested", findings: [] })).errors.some((e) => /'changes-requested' must identify at least one finding/.test(e)));
});

test("cross-field: a finding cannot be BOTH a duplicate and reviewer-claimed newly-discovered", () => {
  const art = build({ findings: [
    { findingId: "A", severity: "low", category: "style", duplicateOfFindingId: "B", reviewerClaimedNewlyDiscovered: true },
    { findingId: "B", severity: "low", category: "style" },
  ] });
  assert.ok(validateReviewResult(art).errors.some((e) => /marked duplicate yet reviewerClaimedNewlyDiscovered=true/.test(e)));
});

test("novelty is OPTIONAL/unknown by default — reviewers are never forced to claim it", () => {
  const art = build({ findings: [{ findingId: "A", severity: "low", category: "style" }] });
  assert.equal(art.findings[0].reviewerClaimedNewlyDiscovered, null); // unknown, NOT false
  assert.equal(validateReviewResult(art).valid, true);
});

// ---------------- artifact identity ----------------
test("artifactId is VERIFIED not trusted: a tampered id is rejected", () => {
  const art = build(); art.artifactId = "deadbeef";
  assert.ok(validateReviewResult(art).errors.some((e) => /artifactId does not match canonical content hash/.test(e)));
});

test("artifactId covers semantic identity, excludes only the volatile timestamp", () => {
  const a = build();
  assert.notEqual(a.artifactId, build({ outcome: "clean", findings: [] }).artifactId); // outcome+findings included
  assert.notEqual(a.artifactId, build({ reviewerRole: "standard" }).artifactId);        // role included
  assert.notEqual(a.artifactId, build({ reviewedHeadCommit: "zzz" }).artifactId);        // reviewed range included
  assert.equal(build({}, 111).artifactId, build({}, 222).artifactId);                    // timestamp excluded
});

// ---------------- finding identity scope ----------------
test("findingId scope: bare id is review-local; composite is the global identity", () => {
  assert.equal(compositeFindingId("run-1", "rev-adv-7", "F1"), "run-1::rev-adv-7::F1");
  assert.notEqual(compositeFindingId("run-1", "rev-a", "F1"), compositeFindingId("run-1", "rev-b", "F1"));
});
