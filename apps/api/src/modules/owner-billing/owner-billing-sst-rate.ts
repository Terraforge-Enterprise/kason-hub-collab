// Owner-Billing — per-unit management-fee SST rate resolver.
//
// A tiny SERVICE-layer orchestrator (not a repository query, not business
// logic owned by one caller) deliberately kept in its OWN file: both
// owner-billing.service.ts (statement generate + line add/edit/void SST
// recompute) and billing-documents/issue.service.ts (the IVOWN document mint)
// need the SAME per-unit SST% a statement's management_fee lines were
// computed with, and issue.service.ts must NOT import owner-billing.service.ts
// (that would create a two-way circular import — owner-billing.service.ts
// already imports issueStatementIvownDocumentTx from issue.service.ts). This
// file has no dependency on either, so both can import it safely.
//
// Also keeps unit-test mockability intact: this module's calls to
// resolveOwnerUnitsForMonth / findFeeConfigsForOwner are CROSS-module imports
// from owner-billing.repository.ts, so a test file's `vi.mock("../owner-billing.repository", …)`
// (which several owner-billing unit-test files already use to keep the DB out
// of the loop) transparently intercepts them here too — unlike putting this
// orchestration INSIDE owner-billing.repository.ts, where same-file calls
// between two of that module's own exports cannot be intercepted by mocking
// the module from outside.
import {
  findFeeConfigsForOwner,
  resolveConfigForUnit,
  resolveOwnerUnitsForMonth,
  type SstRateByUnit,
} from "./owner-billing.repository";

/**
 * Resolve the per-unit management-fee SST rate map for an owner + billing
 * period, using the SAME config precedence (`resolveConfigForUnit`) and inputs
 * (`resolveOwnerUnitsForMonth` + `findFeeConfigsForOwner`) the statement
 * generate path used to compute each management_fee line's SST
 * (owner-billing.service.ts generateStatementService → computeManagementFee).
 * Callers needing a unit's authoritative SST% (statement line add/edit/void
 * recompute, IVOWN document mint) resolve it through this ONE function, so the
 * rate a document/recompute carries can never diverge from the rate that
 * produced the statement figure.
 *
 * `resolveOwnerUnitsForMonth` is called with `{ includeUnmanaged: true }`
 * DELIBERATELY — this map must reproduce the SST% for management_fee lines that
 * were generated while a unit was under management, even after the unit is
 * later flipped un-managed. The recompute (voidStatementLineService has NO
 * draft guard — it can run on an APPROVED statement) and the IVOWN mint both
 * consume already-generated lines; using the gated default here would drop a
 * flipped unit from the map and silently zero its surviving mgmt-fee SST on a
 * finalized statement (recompute) or throw IVOWN_SST_RATE_UNRESOLVED (mint).
 */
export async function resolveMgmtFeeSstRateByUnit(
  orgId: string,
  ownerPartyId: string,
  periodMonth: Date,
): Promise<SstRateByUnit> {
  const map: SstRateByUnit = new Map();
  const [units, configs] = await Promise.all([
    resolveOwnerUnitsForMonth(orgId, ownerPartyId, periodMonth, { includeUnmanaged: true }),
    findFeeConfigsForOwner(orgId, ownerPartyId),
  ]);
  for (const unit of units) {
    const config = resolveConfigForUnit(configs, unit, periodMonth);
    if (config) map.set(unit.unitId, config.sstPercent.toString());
  }
  return map;
}
