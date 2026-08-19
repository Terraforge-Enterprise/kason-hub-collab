import { getDb } from "@kason/db";
import { runEnablementPreflight, PREFLIGHT_KNOWN_LIMITATIONS } from "../modules/owner-ledger/reconciliation/preflight";

/**
 * Headless owner closed-period enablement preflight (R9/R10).
 *
 * Runs the executable enablement preflight for EVERY org and reports pass/fail with
 * reasons, exiting non-zero if ANY org is not safe to enable. This is the runnable gate
 * that decides whether ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER can be turned on.
 *
 * FLAG-INDEPENDENT + READ-ONLY (spec R10): a thin wrapper over `runEnablementPreflight`,
 * which never references the live-ledger flag and writes nothing. Mirrors the org-by-org,
 * per-org-isolated shape of reconcile-owner-closed-period.ts — one org's failure is a
 * FAIL for that org (fail-closed), never an aborted sweep.
 */
export async function runOwnerClosedPeriodPreflightCli(): Promise<{
  overallPass: boolean;
  orgs: Array<{ orgId: string; pass: boolean; reasons: string[] }>;
}> {
  const db = getDb();
  const orgs = await db.organization.findMany({ select: { id: true } });

  const results: Array<{ orgId: string; pass: boolean; reasons: string[] }> = [];
  for (const org of orgs) {
    try {
      const r = await runEnablementPreflight({ orgId: org.id });
      results.push({ orgId: org.id, pass: r.pass, reasons: r.reasons });
    } catch (e) {
      // Per-org isolation: an org whose preflight errors is treated as NOT passable
      // (fail-closed) — never let one org's error abort the whole gate.
      results.push({ orgId: org.id, pass: false, reasons: [`preflight error: ${(e as Error).message}`] });
    }
  }

  const overallPass = results.every((r) => r.pass);
  return { overallPass, orgs: results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOwnerClosedPeriodPreflightCli().then((r) => {
    for (const o of r.orgs) {
      // eslint-disable-next-line no-console
      console.log(
        `[owner-closed-period-preflight] org ${o.orgId}: ${o.pass ? "PASS" : "FAIL"}` +
          (o.reasons.length ? ` — ${o.reasons.join("; ")}` : ""),
      );
    }
    // Known gaps are the same for every org — surface them once so a green result is not
    // mistaken for a clean bill of health.
    for (const limitation of PREFLIGHT_KNOWN_LIMITATIONS) {
      // eslint-disable-next-line no-console
      console.log(`[owner-closed-period-preflight] known limitation: ${limitation}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[owner-closed-period-preflight] overall: ${r.overallPass ? "PASS" : "FAIL"}`);
    process.exit(r.overallPass ? 0 : 1);
  });
}
