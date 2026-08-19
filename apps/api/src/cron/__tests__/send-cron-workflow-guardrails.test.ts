import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the send-owner-statements cron GitHub workflow against the same safety
// regressions its freeze sibling pins (schedule disarmed, flag never hardcoded on,
// packages built before the run), plus the two properties specific to sending.
// Text-level contract on the YAML (no yaml parser in this workspace) — each
// assertion pins one safety property so it cannot silently reappear.
const here = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src/cron/__tests__
const repoRoot = resolve(here, "../../../../.."); // → worktree root
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/cron-send-owner-statements.yml"),
  "utf8",
);

// A YAML line is "live" (not commented) when its first non-space char is not '#'.
const isLive = (line: string) => /^\s*[^#\s]/.test(line);
const lines = workflow.split("\n");

// The flag guards MUST look only at LIVE lines: the disarm comment discusses the env
// expression, so matching the whole file would let comment text satisfy the positive
// guard (and mask a hardcoded literal on the real env line).
const liveFlagLines = lines.filter(
  (l) => isLive(l) && /ENABLE_OWNER_STATEMENT_AUTO_SEND:/.test(l),
);

describe("cron-send-owner-statements.yml guardrails", () => {
  it("no LIVE `schedule:` trigger — schedule stays commented (DISARMED)", () => {
    const liveSchedule = lines.some((l) => isLive(l) && /^\s*schedule:/.test(l));
    expect(liveSchedule).toBe(false);
  });

  it("workflow_dispatch is the live trigger", () => {
    const liveDispatch = lines.some((l) => isLive(l) && /^\s*workflow_dispatch:/.test(l));
    expect(liveDispatch).toBe(true);
  });

  it("Critical: the run job pins an explicit GitHub environment (env-scoped DATABASE_URL)", () => {
    const hasEnvPin = lines.some((l) => isLive(l) && /^\s*environment:\s*\S+/.test(l));
    expect(hasEnvPin).toBe(true);
  });

  it("Critical: the flag is NOT hardcoded on — it comes from a dispatch input", () => {
    expect(liveFlagLines.length).toBeGreaterThan(0);
    for (const line of liveFlagLines) {
      // A literal "true"/"1"/"yes" on the env line would send every run, on every
      // branch, the moment anyone dispatches the workflow for an unrelated reason.
      expect(line).not.toMatch(
        /ENABLE_OWNER_STATEMENT_AUTO_SEND:\s*["']?(true|1|yes|on)["']?\s*$/i,
      );
      expect(line).toMatch(/ENABLE_OWNER_STATEMENT_AUTO_SEND:\s*\$\{\{\s*inputs\./);
    }
  });

  it("Critical: the flag has a schedule-visible fallback — a scheduled run must not silently no-op", () => {
    // A `schedule:` event carries an EMPTY `inputs` context. `${{ inputs.x }}` alone
    // resolves to "" ⇒ flag OFF ⇒ every scheduled run passes GREEN while sending
    // nothing. This is the exact bug the freeze workflow shipped with; pin the fix.
    for (const line of liveFlagLines) {
      expect(line).toMatch(/\|\|\s*vars\./);
    }
  });

  it("Important: builds @kason/db and @kason/shared before running the cron (not dead-on-arrival)", () => {
    const dbBuildIdx = lines.findIndex((l) => isLive(l) && /@kason\/db run build/.test(l));
    const sharedBuildIdx = lines.findIndex((l) => isLive(l) && /@kason\/shared run build/.test(l));
    const runIdx = lines.findIndex((l) => isLive(l) && /cron:send-owner-statements/.test(l));
    expect(dbBuildIdx).toBeGreaterThan(-1);
    expect(sharedBuildIdx).toBeGreaterThan(-1);
    expect(dbBuildIdx).toBeLessThan(runIdx);
    expect(sharedBuildIdx).toBeLessThan(runIdx);
  });

  it("Important: disarm comment cites the default-branch-only schedule rule", () => {
    expect(workflow.toLowerCase()).toMatch(/default branch/);
  });

  it("Important: the schedule is DAILY, not monthly — the org picks the day, not this file", () => {
    // A monthly cron here would hardcode ONE send day for EVERY org and silently
    // contradict Organization.ownerStatementSendDay. The commented schedule must
    // stay daily so the per-org threshold check is what decides.
    const scheduleComment = lines.find((l) => /^\s*#\s*-\s*cron:/.test(l));
    expect(scheduleComment).toBeDefined();
    // "0 1 * * *" — day-of-month field is a wildcard.
    expect(scheduleComment).toMatch(/cron:\s*["']\S+\s+\S+\s+\*\s+\S+\s+\S+["']/);
  });
});
