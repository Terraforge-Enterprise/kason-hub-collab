import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the freeze-owner-statements cron GitHub workflow against the SAME safety
// regressions the auto-draft guardrails pin (schedule disarmed, flag never hardcoded
// on, packages built before the run). Text-level contract on the YAML (no yaml parser
// in this workspace) — each assertion pins one Critical/Important safety property so
// it cannot silently reappear.
const here = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src/cron/__tests__
const repoRoot = resolve(here, "../../../../.."); // → worktree root
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/cron-freeze-owner-statements.yml"),
  "utf8",
);

// A YAML line is "live" (not commented) when its first non-space char is not '#'.
const isLive = (line: string) => /^\s*[^#\s]/.test(line);

// The flag guards MUST look only at LIVE lines: the disarm comment quotes the env
// expression verbatim, so matching the whole file would let comment text satisfy the
// positive guard (and mask a hardcoded literal on the real env line).
const liveFlagLines = workflow
  .split("\n")
  .filter((l) => isLive(l) && /ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER:/.test(l));

describe("cron-freeze-owner-statements.yml guardrails", () => {
  it("Rail 6: no LIVE `schedule:` trigger — schedule stays commented (DISARMED)", () => {
    const liveSchedule = workflow
      .split("\n")
      .some((l) => isLive(l) && /^\s*schedule:\s*$/.test(l));
    expect(liveSchedule).toBe(false);
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

  it("Critical: the flag is NOT hardcoded on — it is a dispatch input", () => {
    expect(liveFlagLines.length).toBeGreaterThan(0);
    for (const line of liveFlagLines) {
      expect(line).not.toMatch(
        /ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER:\s*["']?(?:true|1)["']?\s*(?:#.*)?$/i,
      );
      expect(line).toMatch(/ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER:\s*\$\{\{\s*inputs\./);
    }
  });

  it("Important: builds @kason/db and @kason/shared before running the cron (not dead-on-arrival)", () => {
    const runIdx = workflow.lastIndexOf("cron:freeze-owner-statements");
    const dbBuildIdx = workflow.indexOf("@kason/db run build");
    const sharedBuildIdx = workflow.indexOf("@kason/shared run build");
    expect(dbBuildIdx).toBeGreaterThan(-1);
    expect(sharedBuildIdx).toBeGreaterThan(-1);
    expect(dbBuildIdx).toBeLessThan(runIdx);
    expect(sharedBuildIdx).toBeLessThan(runIdx);
  });

  it("Important: disarm comment cites the default-branch-only schedule rule", () => {
    expect(workflow.toLowerCase()).toMatch(/default branch/);
  });

  it("Important: disarm comment warns scheduled runs get EMPTY inputs → flag OFF (silent money-path miss)", () => {
    expect(workflow).toMatch(/empty `inputs`/i);
    expect(workflow).toMatch(/schedule[\s\S]*?(resolves to ""|flag off)/i);
  });
});
