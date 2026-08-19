# sdd-timing — post-hoc analyzer

Observational timing analyzer for SDD runs. **Reads only**; it is never on the SDD
control path and cannot alter, block, or slow the workflow. Spec:
`docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md`.

## What this commit contains
- `analyze.mjs` — CLI + `analyzeRun()`/`renderMarkdown()`.
- `lib/transcript.mjs` — parse `agent-*.jsonl` + `*.meta.json` → span (timings, tokens,
  tool durations, conservative stage/task inference).
- `lib/dag.mjs` — time model (**observed span envelope** / aggregate) + critical path
  (authoritative observed DAG vs estimated stage-layered), malformed-DAG → `unavailable`/`incomplete`.

### Metric semantics (honest naming)
- `observedSpanEnvelopeMs` = `max(span end) − min(span start)` over **observed** spans. This is a
  span envelope, **not** proven run wall-clock — status `incomplete` unless observed run-start/run-end
  events prove boundaries (forward logger). Authoritative `wallClockMs` is emitted only then.
- `aggregateAgentMs` is authoritative **for observed spans only** (`scope: "observed-spans"`); span-set
  completeness is not proven.
- `residualUnobservedElapsedMs` = `observedSpanEnvelopeMs − estimatedActiveCriticalPathMs`. A neutral,
  multi-cause **unattributed gap** (human idle, queueing, missing transcripts, inferred-edge error, …);
  it does **not** prove human-away time.
- Low-confidence generic `review` → stage `review-ambiguous`, **excluded** from the estimated stage
  path by default; counted in aggregate/envelope; opt in with `includeLowConfidence` for exploration.
- `lib/gitmetrics.mjs` — base..head diff metrics; `unknown` when no range recorded.
- `fixtures/` + `*.test.mjs` — behavioral/adversarial/golden tests (`node --test`).

## What this commit does NOT contain (deferred, separate commit)
The **forward logger**, **gate wrapper**, **review-result template**, and any SDD
orchestration change. Until those exist, `fastMode`, `effort`, `baseCommit`/`headCommit`,
review `outcome`/`findings`, `rework`, and reviewer-value metrics are reported as
`unknown`/`unavailable` — never inferred from prose.

## Usage
```
node scripts/sdd-timing/analyze.mjs --dir <run>/subagents --run <id> --out <prefix>
# writes <prefix>.json and <prefix>.md
```
Historical runs are labelled **ILLUSTRATIVE** and, per spec §6/§8, **must not** justify any
change to task granularity, reviewer ordering, or gate sequencing. The `--observed` flag is
reserved for future forward-log runs that carry authoritative `parentSpanId` edges.

## Gate wrapper (`gate-run.mjs`)
Observes a gate command's timing/exit WITHOUT changing its behaviour.
```
node scripts/sdd-timing/gate-run.mjs \
  --sdd-events-dir <dir> --sdd-run <runId> --sdd-gate-id <id> \
  [--sdd-task <id>] [--sdd-gate-commit <sha>] [--sdd-intended-commit <sha>] \
  -- <command> [args...]
```
**Process/signal model (supervising parent — NOT `exec`).** The wrapper `spawn`s the
child in its **own process group** (`detached`), inherits stdio (output streams live; never
captured), inherits cwd + env, and passes argv as an array (no shell/glob; empty strings
preserved). Because the child is in a separate group, a terminal delivers Ctrl+C to the
wrapper's group only — the wrapper then **forwards the signal to the child's group exactly
once** (`process.kill(-pgid, sig)`), reaching the whole `npm→runner→worker` tree so nothing
is orphaned (verified: distinct pgids + single delivery + full-tree teardown).

**Termination contract.** The wrapper **normalises signal death to a normal exit with
status `128+signal`** — it exits *normally* with that code; it does **not** re-raise the
signal. So `$?` in a shell is identical to the unwrapped command, but a `waitpid()` caller
sees `WIFEXITED(128+sig)`, not `WIFSIGNALED(sig)`.

| child outcome | wrapper exit | event |
|---|---|---|
| exits with code C | C | gate-end |
| killed by signal S | `128 + S` (SIGTERM→143, SIGINT→130) | gate-interrupted |
| command not found (ENOENT) | 127 | gate-end |
| not executable (EACCES) | 126 | gate-end |

**Instrumentation never changes gate truth** — a logger/FS/git failure warns to stderr
(non-blocking ≠ silent) but the exit status is always the child's real result.

**Records:** exact `argv` (array) + separate human `displayCommand`, `cwd`, epoch start/end,
monotonic duration, `exitCode` **or** `terminatingSignal`, and commit provenance:
`intendedGateCommit` (controller-claimed) vs `observedGateCommit` (wrapper reads HEAD before,
and again after to catch mid-gate change), plus `dirtyWorktree`. The analyzer calls a gate
`commitMatch: "matched"` **only from the observed value** (never the controller claim alone);
intended≠observed / changed-during / unobservable are hard issues, dirty is a soft warning.
`testCount`/`cacheReported` stay **null with provenance** — never prose-parsed or inferred.

**Adoption note:** using the wrapper in real SDD runs requires the controller to invoke the
gate *through* it — that is an **orchestration edit, intentionally NOT included here**.

## Structured review output (`lib/review-result.mjs`)
The reviewer's artifact — schema + validator + atomic read/write helper. **Not wired into any
reviewer prompt or the controller** (that's a later commit); this is the independently-testable
data layer only.

**Authority boundary (load-bearing).** A `ReviewResult` is the reviewer's surface and carries
**claims only**: `reviewerClaimedNewlyDiscovered`, `duplicateOfFindingId`, `relatedFindingIds`,
`outcome`. It **must not** carry controller conclusions — `reworkOfFindingIds` is rejected here
and lives only in the separate controller-owned **`ReworkLink`**. Authoritative relationships
(adversarial-unique, final-caught-what-others-missed, caused-rework) are produced **later** by
controller reconciliation, never by the reviewer.

- `validateReviewResult` (strict) rejects: duplicate/self/mutual/malformed references, bad
  severity/category/outcome/role enums, missing ids, findings claiming another review, unknown
  fields, unknown schema version, and any `reworkOfFindingIds`. Unresolved cross-review
  references are **preserved** (not errors) for controller reconciliation.
- `buildReviewResult` → deterministic `artifactId` (content hash, excludes volatile timestamp);
  never infers commit ranges (absent → null).
- `writeReviewResult` → validate → temp file → **atomic no-clobber publish via `link()`**
  (fails `EEXIST` instead of clobbering, unlike `rename`) → `review-<spanId>.json`; **never
  leaves a partial or abandoned temp**; **idempotent** for identical content; **refuses** to
  overwrite differing content — verified with real concurrent processes (one winner, rest
  refused, exactly one authoritative artifact). A write/validation failure never changes the
  reviewer's outcome.
- `validateReworkLink` → the separate home for `reworkOfFindingIds`.

**Hardening guarantees:**
- **Path safety** — `runId`/`taskId`/`reviewSpanId` name files, so they must match
  `[A-Za-z0-9._-]{1,128}` (no `/`, `..`, control chars); unsafe ids are rejected before any fs access.
- **`artifactId` is recomputed and VERIFIED** (sha256 over all semantic identity —
  schema/instrumentation versions, run/task/span ids, reviewer role, reviewed range, outcome,
  findings — **excluding only** the volatile `generatedAtEpochMs`); a caller-supplied id is never trusted.
- **Cross-field invariants** — `clean` may not carry a blocking (critical/high) finding;
  `changes-requested` must name ≥1 finding; a duplicate may not also claim newly-discovered;
  novelty stays optional/`null` (unknown) — reviewers are never forced to claim it.
- **Finding identity** — `findingId` is **review-local**; the global identity is
  `compositeFindingId(runId, reviewSpanId, findingId)`; a bare id is never treated as globally unique.
- **Schema↔validator parity** — a test asserts `review-result.schema.json`'s enums/const/keys
  equal the runtime constants, and runs a corpus through both (agree structurally; the runtime is
  a strict superset for the cross-field semantics JSON Schema can't express).

Still **unavailable** until the template + controller commits: reviewers don't yet emit these
artifacts, the controller doesn't yet reconcile them, and `reworkOfFindingIds` isn't yet
authored — so authoritative adversarial-unique / cross-reviewer-miss / rework rollups remain
`unavailable` in the analyzer.

## Controller lifecycle instrumentation (`sdd-log.mjs`) — 3.3A mechanism
The SDD "controller" is an **agent executing `SKILL.md`**, not a program — so there is no code
to hook. `sdd-log.mjs` is the concrete CLI the controller invokes at each stage boundary to
emit run/task/span events (observational, non-blocking, **always exits 0** — logging can never
fail the controller):
```
node scripts/sdd-timing/sdd-log.mjs <event> --run <id> --events-dir <dir> [flags]
  events: run-start | run-end | coverage-interrupt | task-dispatch | task-complete
          | task-failed | span-start | span-end
  span-start: --span S --task T --stage STAGE [--parent P] [--deps a,b]
              [--model M] [--effort E] [--fast true|false]
```
`smoke.mjs` drives one harmless task end-to-end through this CLI **and** the gate wrapper, then
runs the analyzer to produce an **authoritative** report (wall-clock + `criticalPathMs` from
observed edges + stage durations + gate evidence + measured overhead).

**Known limitation:** per-event CLI = one process per event, so span-start/end can't share a
monotonic clock → span durations are **epoch**-derived (flagged `durationClock: "epoch"`), while
run wall-clock (run-start→run-end) is authoritative.

**Activation is NOT wired here.** Making the live controller emit these events requires adding
instructions to the governing `SKILL.md` (a global-blast-radius edit) — presented for approval,
not applied. Until then, every real SDD run is byte-for-byte unchanged.

## Tests
```
node --test scripts/sdd-timing/lib/*.test.mjs scripts/sdd-timing/*.test.mjs
```

## Known heuristics (reviewer: tighten if desired)
- Stage/task come from the free-text `meta.description` or `name` label → classified
  `inferred` with confidence; unmatched labels stay `unknown` (not force-placed).
- A bare `review` in the description matches at **low** confidence (weak signal). Remove that
  branch in `lib/transcript.mjs` if you want only explicit standard/adversarial/re-review.
- Inferred critical path clusters same-rank spans by temporal **overlap** as a parallelism
  proxy — a stated assumption, never labelled authoritative.
