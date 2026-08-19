import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the auto-draft cron GitHub workflow against the safety regressions
// caught in the prd-b-t3-cron-disarmed fix wave, updated for the ARMED model:
// the `schedule:` trigger is now live, but every scheduled job is gated behind
// an explicit repo variable (vars.AUTODRAFT_SCHEDULE_*) and the flag expression
// handles the empty-`inputs` schedule event explicitly. This is a text-level
// contract on the YAML (no yaml parser dependency in this workspace) — each
// assertion pins one Critical/Important finding so it cannot silently reappear.
const here = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src/cron/__tests__
const repoRoot = resolve(here, "../../../../.."); // → worktree root
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/cron-auto-draft.yml"),
  "utf8",
);

// A YAML line is "live" (not commented) when its first non-space char is not '#'.
const isLive = (line: string) => /^\s*[^#\s]/.test(line);

// The ENABLE_PHASE2_AUTODRAFT flag guards below MUST look only at LIVE lines:
// the disarm comment quotes `ENABLE_PHASE2_AUTODRAFT: ${{ inputs.enable_autodraft }}`
// verbatim, so matching the whole file would let comment text satisfy the
// positive guard (and mask a hardcoded literal on the real env line).
const liveFlagLines = workflow
  .split("\n")
  .filter((l) => isLive(l) && /ENABLE_PHASE2_AUTODRAFT:/.test(l));

describe("cron-auto-draft.yml guardrails", () => {
  it("Rail 6: the LIVE schedule fires DAILY at a UTC hour that lands on the MYT calendar day", () => {
    // runDayOfMonth is org-configurable (1–28) and runAutoDraftInvoicesCron
    // matches configs by the UTC day of the fire, so the schedule must be DAILY
    // — a fixed day-of-month schedule silently never serves orgs on other run
    // days. 02:00 UTC = 10:00 MYT the same day; a 16:00–23:59 UTC fire would
    // land on MYT's "yesterday" and query the wrong runDayOfMonth.
    const liveCron = workflow
      .split("\n")
      .filter((l) => isLive(l) && /^\s*-\s*cron:/.test(l));
    expect(liveCron).toHaveLength(1);
    expect(liveCron[0]).toMatch(/-\s*cron:\s*"0 2 \* \* \*"/);
  });

  it("Rail 6b: every job gates its scheduled path behind an explicit arming variable", () => {
    // A live `schedule:` may NEVER mean unconditional drafting: each job's `if`
    // must require a repo variable (vars.AUTODRAFT_SCHEDULE_*) on the schedule
    // event, so an unset variable ⇒ the job is skipped and nothing is drafted.
    // Off remains the default until an operator flips the variable.
    // LIVE lines only, matching the flag assertion below: the header comment
    // quotes the gate expression verbatim, so a whole-file match would let a
    // third UNGATED job pass simply because a comment mentions the pattern.
    const live = workflow.split("\n").filter(isLive);
    const jobCount = live.filter((l) => /^\s*runs-on:/.test(l)).length;
    const gates = live.filter((l) =>
      /github\.event_name == 'schedule' && vars\.AUTODRAFT_SCHEDULE_\w+ == 'true'/.test(l),
    );
    expect(jobCount).toBeGreaterThan(0);
    expect(gates).toHaveLength(jobCount);
  });

  it("Critical: each job checks out its ENVIRONMENT's branch on a schedule, never the default branch", () => {
    // GitHub reads `schedule:` only from the default branch, so a scheduled run's
    // implicit checkout is MASTER — while secrets.DATABASE_URL comes from the
    // job's pinned environment. Left implicit, the nightly uat job would run
    // master's unpromoted code (migrations, rent math) against the CLIENT UAT
    // database. Every checkout must therefore pin a schedule-time ref.
    const live = workflow.split("\n").filter(isLive);
    const checkouts = live.filter((l) => /uses:\s*actions\/checkout/.test(l)).length;
    const refPins = live.filter((l) =>
      /ref:\s*\$\{\{\s*github\.event_name == 'schedule' && '\w+' \|\| github\.ref\s*\}\}/.test(l),
    ).length;
    expect(checkouts).toBeGreaterThan(0);
    expect(refPins).toBe(checkouts);
    // And the branch a scheduled run picks must never be the zero-CI integration
    // branch — that is the whole failure this guard exists to prevent.
    expect(workflow).not.toMatch(/ref:\s*\$\{\{[^}]*'master'[^}]*\}\}/);
  });

  it("Critical: every job pins an explicit environment, and none of them is client-prod", () => {
    const lines = workflow.split("\n");
    const jobCount = lines.filter((l) => isLive(l) && /^\s*runs-on:/.test(l)).length;
    const envPins = lines.filter((l) => isLive(l) && /^\s*environment:\s*\S/.test(l));
    expect(envPins).toHaveLength(jobCount);
    // Arming the client production DB is a deliberate release step with its own
    // job + variable — never a drive-by edit that reuses an existing job.
    for (const pin of envPins) expect(pin).not.toMatch(/client-prod/);
  });

  it("Rail 6: workflow_dispatch is the live trigger", () => {
    const liveDispatch = workflow
      .split("\n")
      .some((l) => isLive(l) && /^\s*workflow_dispatch:\s*$/.test(l));
    expect(liveDispatch).toBe(true);
  });

  it("Critical: the run job pins an explicit GitHub environment (env-scoped DATABASE_URL)", () => {
    const hasEnvPin = workflow
      .split("\n")
      .some((l) => isLive(l) && /^\s*environment:\s*\S/.test(l));
    expect(hasEnvPin).toBe(true);
  });

  it("Critical: ENABLE_PHASE2_AUTODRAFT is never hardcoded — schedule arms it explicitly, dispatch keeps the input", () => {
    // Force-enabling the Phase-2 flag unconditionally overrides the
    // per-environment flag stance; a BARE `inputs.enable_autodraft` resolves to
    // "" on schedule events (flag OFF, green run, zero drafts — the historic
    // silent no-op). The ONE legitimate shape handles both events explicitly:
    // schedule (already armed via the job's vars gate) ⇒ 'true'; dispatch ⇒ the
    // operator's input, which defaults to 'false'. Assert on LIVE lines only —
    // comments may quote expressions.
    expect(liveFlagLines.length).toBeGreaterThan(0);
    for (const line of liveFlagLines) {
      expect(line).not.toMatch(/ENABLE_PHASE2_AUTODRAFT:\s*["']true["']/);
      expect(line).toMatch(
        /ENABLE_PHASE2_AUTODRAFT:\s*\$\{\{\s*github\.event_name == 'schedule' && 'true' \|\| inputs\.enable_autodraft\s*\}\}/,
      );
    }
  });

  it("Important: builds @kason/db and @kason/shared before running the cron (not dead-on-arrival)", () => {
    // tsx runs the cron against @kason/db + @kason/shared, both of which resolve
    // main: ./dist/index.js and are NOT committed — they must be built in-job.
    // lastIndexOf: the string also appears in the line-4 header comment; we
    // want the actual `run: npm run cron:auto-draft-invoices` invocation.
    const runIdx = workflow.lastIndexOf("cron:auto-draft-invoices");
    const dbBuildIdx = workflow.indexOf("@kason/db run build");
    const sharedBuildIdx = workflow.indexOf("@kason/shared run build");
    expect(dbBuildIdx).toBeGreaterThan(-1);
    expect(sharedBuildIdx).toBeGreaterThan(-1);
    // Both builds must precede the cron invocation.
    expect(dbBuildIdx).toBeLessThan(runIdx);
    expect(sharedBuildIdx).toBeLessThan(runIdx);
  });

  it("Critical: every job that drafts also BILLS — a job that only drafts strands money", () => {
    // An environment where drafts appear nightly but are never billed is worse
    // than one where neither runs: the queue grows, nobody is charged, and the
    // schedule looks healthy the whole time.
    const draftRuns = workflow
      .split("\n")
      .filter((l) => isLive(l) && /run:\s*npm run cron:auto-draft-invoices/.test(l));
    const billRuns = workflow
      .split("\n")
      .filter((l) => isLive(l) && /run:\s*npm run cron:auto-bill-invoices/.test(l));
    expect(draftRuns.length).toBeGreaterThan(0);
    expect(billRuns.length).toBe(draftRuns.length);
  });

  it("Critical: auto-bill runs AFTER auto-draft in every job", () => {
    // Load-bearing order. With runDayOfMonth === autoBillDayOfMonth (the common
    // "draft and bill on the 1st" setup) drafting first is what lets ONE nightly
    // fire do both. Reversed, it bills yesterday's drafts and leaves today's
    // until tomorrow — a silent one-day-late billing cycle, every month.
    const lines = workflow.split("\n");
    const draftIdx: number[] = [];
    const billIdx: number[] = [];
    lines.forEach((l, i) => {
      if (!isLive(l)) return;
      if (/run:\s*npm run cron:auto-draft-invoices/.test(l)) draftIdx.push(i);
      if (/run:\s*npm run cron:auto-bill-invoices/.test(l)) billIdx.push(i);
    });
    expect(billIdx.length).toBe(draftIdx.length);
    // Pairwise in file order: each job's bill step follows its own draft step.
    for (let i = 0; i < billIdx.length; i++) {
      expect(billIdx[i]).toBeGreaterThan(draftIdx[i]);
    }
  });

  it("Important: the workspace builds precede the auto-BILL step too", () => {
    // Same dead-on-arrival trap as the draft step: @kason/db and @kason/shared
    // resolve to uncommitted dist/, so a bill step ahead of the builds would
    // ERR_MODULE_NOT_FOUND every night.
    const billIdx = workflow.lastIndexOf("cron:auto-bill-invoices");
    expect(workflow.indexOf("@kason/db run build")).toBeLessThan(billIdx);
    expect(workflow.indexOf("@kason/shared run build")).toBeLessThan(billIdx);
  });

  it("Important: the disarm comment does not falsely claim a non-master branch can arm the schedule", () => {
    // GitHub evaluates schedule: ONLY from the default branch (master). The
    // old comment ("arms the schedule on the branch that should actually run
    // it") would send an operator to arm on uat/prod — a silent no-op.
    expect(workflow).not.toMatch(/on the branch that should actually run it/);
    expect(workflow.toLowerCase()).toMatch(/default branch/);
  });

  it("Important: the header still documents the empty-inputs trap the flag expression exists to defeat", () => {
    // A `schedule:` event carries NO `inputs`, so a bare
    // `${{ inputs.enable_autodraft }}` resolved to "" (flag OFF) and every
    // scheduled run passed GREEN while drafting NOTHING. The expression now
    // handles the schedule event explicitly, and the comment must keep teaching
    // WHY, or a future "simplification" back to the bare input reintroduces the
    // silent money-path miss.
    expect(workflow).toMatch(/carries no `inputs`/i);
    expect(workflow.toLowerCase()).toMatch(/silent no-op/);
  });

  it("Critical: ENABLE_PHASE2_AUTODRAFT is not hardcoded on via a bare true/1 literal", () => {
    // Broadens the negative guard beyond `"true"`: isPhase2FlagEnabled also
    // accepts "1", and GitHub serializes unquoted YAML booleans (`true`, `True`,
    // `TRUE` — all YAML booleans) to the string "true". A hardcoded literal
    // (quoted or not, any case) on the flag line re-enables always-on drafting;
    // only a `${{ ... }}` expression is legitimate. Case-insensitive and
    // comment-tolerant (a trailing `# note` must not defeat the `$` anchor),
    // scanned per LIVE line so the anchor binds to that line's end.
    for (const line of liveFlagLines) {
      expect(line).not.toMatch(
        /ENABLE_PHASE2_AUTODRAFT:\s*["']?(?:true|1)["']?\s*(?:#.*)?$/i,
      );
    }
  });
});
