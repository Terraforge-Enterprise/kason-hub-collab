import { getDb } from "@kason/db";
import { CASH_ALLOCATION_WHERE } from "@kason/shared";
import { sumReversalsForAllocations } from "../payments/payments.repository";

/** Half-up to 2 decimals. Mirrors bills-grid/service.ts's local `round2`
 *  (meter/compute.ts is byte-frozen; deliberately not imported from it). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Field-level guard for the two commission columns (Phase 1 spec R7). A "change"
// is: create with a non-default value, or update with a value differing from
// stored. Only admin/manager may change them; beyond that the columns stay
// editable until MONEY HAS ACTUALLY BEEN RECEIVED against the tenancy's rent or
// letting_commission charges.
//
// It used to lock on the mere EXISTENCE of an Invoice or rent Charge in any
// status, chosen so the predicate would be monotonic. That traded a correctable
// mistake for an uncorrectable one: Invoice.status defaults to "draft", so a
// never-issued draft froze the fields forever, and because a `void` Invoice
// counted too — and there is no DELETE route for invoices — voiding could not
// release the lock either. There was no in-app path back.
//
// So the predicate now measures cash, matching the rule admins already meet on
// the bills grid (rebill-assessment.ts's `paid > 0.005`), and is DELIBERATELY
// NON-MONOTONIC: reversing a payment re-opens the fields, exactly as
// assessPaidBlockers behaves for a re-Bill. That is the accepted cost of the two
// surfaces agreeing on when billing data becomes immutable.
//
// The allocation read MUST keep `CASH_ALLOCATION_WHERE`. Portal payments mint
// PaymentAllocation rows at INITIATE, before the bank confirms anything, and
// expiry/failure/rejection never remove them — an unfiltered read would lock
// these columns on money that never arrived. `allocation-cash-filter.guard.test.ts`
// pins this file by name so a refactor cannot quietly drop the filter.
//
// Extracted from tenancy.service.ts so the inventory occupancy path
// (updateUnitService / createUnitService / createUnitsBatchService) enforces the
// SAME rule. The session param is the structural `{ role, orgId }` shape both
// TenancySession and InventorySession satisfy. Reads go via getDb() (outside any
// caller transaction) exactly as the tenancy path does.
export async function assertCommissionWritable(
  session: { role: string; orgId: string },
  changing: boolean,
  tenancyId: string | null,
): Promise<{ ok: true } | { ok: false; status: 403 | 409; error: string; code: string }> {
  if (!changing) return { ok: true };
  if (session.role !== "admin" && session.role !== "manager") {
    return { ok: false, status: 403, error: "Only admin or manager may set the commission fields", code: "COMMISSION_FIELDS_FORBIDDEN" };
  }
  if (tenancyId) {
    const db = getDb();
    const charges = await db.charge.findMany({
      where: {
        organizationId: session.orgId,
        tenancyId,
        chargeType: { in: ["rent", "letting_commission"] },
      },
      select: { id: true },
    });
    if (charges.length > 0) {
      const allocs = await db.paymentAllocation.findMany({
        where: {
          organizationId: session.orgId,
          chargeId: { in: charges.map((c) => c.id) },
          ...CASH_ALLOCATION_WHERE,
        },
        select: { id: true, allocatedAmount: true },
      });
      if (allocs.length > 0) {
        const reversed = await sumReversalsForAllocations(db, session.orgId, allocs.map((a) => a.id));
        // Gate EACH allocation at the threshold before summing, exactly as
        // rebillSupersedeTx does. Summing raw nets instead would let an
        // over-reversed allocation (negative net) cancel out a genuinely paid
        // one and wrongly re-open the fields.
        let net = 0;
        for (const a of allocs) {
          const one = round2(Number(a.allocatedAmount.toString()) - (reversed.get(a.id) ?? 0));
          if (one > 0.005) net = round2(net + one);
        }
        if (net > 0.005) {
          return {
            ok: false,
            status: 409,
            error: "Commission fields are locked once a payment has been received against this tenancy",
            code: "COMMISSION_FIELDS_LOCKED",
          };
        }
      }
    }
  }
  return { ok: true };
}
