import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the reconcile-owner-closed-period cron GitHub workflow against the SAME safety
// regressions the freeze cron guardrails pin (schedule DISARMED, explicit environment,
// packages built before the run). Text-level contract on the YAML (no yaml parser in this
// workspace). NOTE: unlike the freeze cron, this cron is FLAG-INDEPENDENT (spec R10) — the
// reconciliation net must run before the live-ledger flag is enabled — so there is
// deliberately NO enable-flag dispatch input to pin.
const here = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src/cron/__tests__
const repoRoot = resolve(here, "../../../../.."); // → worktree root
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/cron-reconcile-owner-closed-period.yml"),
  "utf8",
);

// A YAML line is "live" (not commented) when its first non-space char is not '#'.
const isLive = (line: string) => /^\s*[^#\s]/.test(line);

describe("cron-reconcile-owner-closed-period.yml guardrails", () => {
  it("no LIVE `schedule:` trigger — schedule stays commented (DISARMED)", () => {
    const liveSchedule = workflow.split("\n").some((l) => isLive(l) && /^\s*schedule:\s*$/.test(l));
    expect(liveSchedule).toBe(false);
  });

  it("workflow_dispatch is the live trigger", () => {
    const liveDispatch = workflow.split("\n").some((l) => isLive(l) && /^\s*workflow_dispatch:\s*$/.test(l));
    expect(liveDispatch).toBe(true);
  });

  it("the run job pins an explicit GitHub environment (env-scoped DATABASE_URL)", () => {
    const hasEnvPin = workflow.split("\n").some((l) => isLive(l) && /^\s*environment:\s*\S/.test(l));
    expect(hasEnvPin).toBe(true);
  });

  it("builds @kason/db and @kason/shared before running the cron (not dead-on-arrival)", () => {
    const runIdx = workflow.lastIndexOf("cron:reconcile-owner-closed-period");
    const dbBuildIdx = workflow.indexOf("@kason/db run build");
    const sharedBuildIdx = workflow.indexOf("@kason/shared run build");
    expect(dbBuildIdx).toBeGreaterThan(-1);
    expect(sharedBuildIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    expect(dbBuildIdx).toBeLessThan(runIdx);
    expect(sharedBuildIdx).toBeLessThan(runIdx);
  });

  it("disarm comment cites the default-branch-only schedule rule", () => {
    expect(workflow.toLowerCase()).toMatch(/default branch/);
  });
});
