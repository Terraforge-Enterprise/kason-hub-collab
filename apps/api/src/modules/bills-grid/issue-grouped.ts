// apps/api/src/modules/bills-grid/issue-grouped.ts
//
// Task 6 (agency-billing-itemization, grid-scoped grouped invoice issuance).
// Groups the charges Task 5's `mintItemizedCharges` mints — one Charge per
// non-zero utility component (incl. a genuinely negative subsidy line) — into
// ONE itemized BillingDocument PER COUNTERPARTY, replacing the interim
// `issueDocumentsForChargesTx` per-charge issuance service.ts used before Task
// 6 (one document per charge). Does NOT modify `issueDocumentsForChargesTx`
// — the meter/service.ts shared-pool path still uses that per-charge issuer
// unchanged.
//
// GROUPING KEY: (counterpartyType, partyId, unitId, billingMonth,
// docType-from-category).
//   - unitId is a Listing id — the SAME field for a tenant room charge
//     (`unitId: a.unitId`) and an owner charge (`unitId: owner.listingId`,
//     often the SAME physical listing as one of the tenant rooms).
//   - counterpartyType is derived from EACH charge's OWN category.family
//     ("owner_income" → owner, else tenant) and PREFIXES the key — a
//     money-routing review finding: tenant AND owner utility categories are
//     BOTH docType:"invoice" (see electricity_tenant/electricity_owner,
//     packages/shared/src/constants/seed-categories.ts), so partyId used to be
//     the ONLY discriminator. If a tenant charge and an owner charge ever
//     shared the same (partyId, unitId, billingMonth, docType) — which
//     requires the property owner to also be the room's tenant, an
//     "owner-occupier" not currently a KAEN scenario but NOT prevented by any
//     code guard — the old key collided and silently merged the owner-borne
//     charge onto the tenant's IVTEN (no IVOWN issued, ownerInvoiceIds empty).
//     Prefixing with counterpartyType means tenant-side and owner-side
//     charges can NEVER land in the same group, regardless of
//     partyId/unitId. A fail-closed guard (GroupedIssuanceMixedFamilyError)
//     asserts this invariant defensively — structurally unreachable given the
//     prefixed key, but throws rather than silently mis-routing if it's ever
//     violated by a future edit to the key.
//   - docType is read off each charge's OWN ChargeCategory (never assumed) so
//     a future category-routing change can never silently combine an invoice
//     line with a debit_note line in one document.
//
// One issueDocumentTx (issue.service.ts:69) call PER GROUP, one line per
// charge in that group. counterpartyType is derived the SAME way the shared
// issuer derives it: category.family "owner_income" → owner, else tenant.
//
// idempotencyKey: `grid-doc:${counterpartyType}:${partyId}:${unitKey}:${ym}:${docType}`
// + a `:r${revision}` suffix when revision > 0. The counterpartyType segment is
// a NECESSARY corollary of the grouping-key fix above: issueDocumentTx dedupes
// on {organizationId, idempotencyKey} ALONE (issue.service.ts:82-87, no
// counterpartyType involved) — without this segment, the owner-occupier
// collision case above would produce TWO groups with the IDENTICAL
// idempotencyKey (same partyId/unitId/ym/docType), and the second
// issueDocumentTx call would dedupe-return the FIRST group's document,
// silently aliasing the owner invoice onto the tenant's at the persistence
// layer even though the in-memory grouping was already correct. Every OTHER
// existing component and the `:r${revision}` suffix are unchanged. REQUIRED
// (independent of the above) because issueDocumentTx's dedupe has NO
// documentStatus filter — it returns ANY existing doc for that key, including
// a CANCELLED one. Without the revision suffix, a Task-8 re-Bill (revision >
// 0) reusing the SAME group key would find the CANCELLED prior-attempt
// document and mint nothing instead of a fresh document.
//
// P4 (accounting-document redesign, 2026-07-22): a tenant-borne bills-grid expense
// charge (chargeType "expense", sourceGridExpenseId set) is a RECEIVABLE for money
// KAEN paid on the tenant's behalf, not KAEN service revenue — it must NOT co-group
// onto the tenant's IVTEN. When ENABLE_EXPENSE_BILL is ON, such a charge is routed
// onto its own "Expense Bill" (EB-) document via an EXPLICIT `seriesCode: "EB"`
// override passed to issueDocumentTx below (the SAME override mechanism CN/RN and
// the IVOWN statement mint already use — see issue.service.ts's `seriesCode` param:
// "explicit code wins; otherwise route via the first line's category"). No new
// ChargeCategory is added for this — the line keeps its normal tenant_income/IVTEN
// category (mintExpenseChargesTx, service.ts, is UNCHANGED by this phase), only the
// DOCUMENT's series is overridden. This is the SAME hazard shape the
// counterpartyType-prefix fix above closes: electricity_tenant and
// other_expense_tenant are BOTH docType:"invoice" family:"tenant_income"
// (seed-categories.ts), so an EB-routed charge and an ordinary IVTEN charge for the
// SAME tenant/unit/month would otherwise compute the IDENTICAL grouping key/
// idempotencyKey and silently co-mingle onto one document. `routedSeries` ("EB" or
// "" for the default category-routed series) is threaded into BOTH the grouping key
// and the idempotencyKey — see their construction below — so an EB group can NEVER
// collide with an IVTEN group. Flag OFF: routedSeries is always "" for every charge
// (see `expenseBillOn` below), so both keys are BYTE-IDENTICAL to pre-P4 — the
// segment is only ever appended, never inserted, when routedSeries is non-empty.
import type { Prisma } from "@kason/db";
import { issueDocumentTx } from "../billing-documents/issue.service";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

/**
 * Which document series a charge's GROUP is routed onto, overriding the series its own
 * category would otherwise resolve. "" means "no override — use the category's series".
 *
 * - tenant + Expense-natured → "EB"  (tenant Expense Bill)
 * - everything else          → ""    (IVOWN / IVTEN / DEP via the line's own category),
 *                                    INCLUDING every owner-borne expense
 *
 * A profit-natured charge is never Expense-natured (see isExpenseCharge at the call
 * site), so KAEN revenue always lands on the ordinary receivable.
 *
 * Exported ONLY so the routing table can be unit-tested against the real resolver
 * rather than a mirror that could silently drift from it.
 */
export function resolveRoutedSeries(opts: {
  counterpartyType: "owner" | "tenant";
  isExpenseCharge: boolean;
  expenseBillOn: boolean;
}): "EB" | "" {
  const { counterpartyType, isExpenseCharge, expenseBillOn } = opts;
  if (!isExpenseCharge) return "";
  // An OWNER-borne expense is always BILLED to the owner as an ordinary IVOWN line —
  // "it needs to show" (operator, 2026-08-16). It is then netted out of the payout when
  // the rent is collected (auto-offset-on-rent.hook.ts), which is the deduction KAEN
  // actually wants: same money, but the owner can see the invoice it came from.
  //
  // The alternative model — no invoice, an OEA advice plus an owner-ledger deduction,
  // gated on ENABLE_OWNER_BORNE_DEDUCT — was removed with that flag. Historical OEA
  // documents still render; nothing mints new ones.
  if (counterpartyType === "owner") return "";
  return expenseBillOn ? "EB" : "";
}

export type GroupedGridInvoiceResult = {
  tenantInvoiceIds: string[];
  /** ALL owner documents issued by this call. An owner can hold MORE THAN ONE document
   * for the same (unit, month) — an IVOWN receivable for profit-natured charges AND an
   * OEA advice for expense-natured ones — so this is an array, never a scalar. It was a
   * scalar assigned last-write-wins, which silently dropped every document but the last
   * once a second owner group became possible. */
  ownerInvoiceIds: string[];
};

type ChargeForGroup = {
  id: string;
  organizationId: string;
  partyId: string;
  tenancyId: string | null;
  unitId: string | null;
  billingMonth: Date | null;
  categoryId: string | null;
  description: string | null;
  amount: { toString(): string };
  sstRate: { toString(): string } | null;
  // SST-payable fix: structural provenance of the SST sibling Charge, so its document
  // line can be marked `isTax` (contributes nothing to subtotal). Recognised by NUMBER,
  // matching how findLiveGridCharges already resolves grid provenance.
  chargeNumber: string;
  // P4 (accounting-document redesign): identify a bills-grid expense charge
  // (chargeType "expense" + sourceGridExpenseId set) so a TENANT-borne one can be
  // routed onto its own EB- Expense Bill. An owner-borne one always stays an IVOWN
  // line — see resolveRoutedSeries.
  chargeType: string;
  sourceGridExpenseId: string | null;
  // Task 5 (charge-nature-expense-profit-routing): the per-charge Expense/Profit
  // "nature" (stamped by the recurring mint, service.ts). When
  // ENABLE_CHARGE_NATURE_ROUTING is ON, nature:"expense" broadens the Expense
  // discriminator below regardless of chargeType — see isExpenseCharge.
  nature: string | null;
  unit: { apartmentId: string; apartment: { propertyId: string } | null } | null;
};

/**
 * Number of the SST sibling Charge that {@link import("./service").mintExpenseChargesTx}
 * mints alongside an SST-bearing grid expense.
 *
 * WHY IT EXISTS: `issueDocumentTx` derives a document's SST from each line's rate and adds
 * it to `total`, but nothing ever wrote that money back to a Charge. Payments settle
 * CHARGES, so the tax was displayed on the invoice, declared to LHDN and owed by the
 * tenant — yet uncollectable, absent from the portal's payable list, and invisible to
 * `deriveDocumentStatus`, which flipped the invoice to "settled" once only the BASE
 * amount was paid. The sibling gives that tax a settling row: Σ charges === document.total.
 *
 * `-SST` sits BEFORE the re-Bill `-r<revision>` suffix so both the reclaim predicate here
 * and `findLiveGridCharges`' `GRIDEXP-${ym}-` prefix match continue to recognise it.
 */
export const expenseSstChargeNumber = (ym: string, expenseId: string, suffix: string): string =>
  `GRIDEXP-${ym}-${expenseId}-SST${suffix}`;

/** Counterpart of {@link expenseSstChargeNumber} — recognises an SST sibling from its
 * number alone (the grouper has no other structural signal, and this mirrors the
 * chargeNumber-provenance convention `findLiveGridCharges` already relies on). */
export const isExpenseSstChargeNumber = (chargeNumber: string): boolean =>
  /^GRIDEXP-.+-SST(-r\d+)?$/.test(chargeNumber);

/** Line SST rate: the per-charge override when present (bill-expenses R2), else the
 * routing category's default. Null override → unchanged legacy behavior. */
export function resolveLineSst(chargeSstRate: { toString(): string } | null, categoryDefault: { toString(): string }): string {
  return chargeSstRate != null ? chargeSstRate.toString() : categoryDefault.toString();
}

type CategoryForGroup = {
  id: string;
  docType: string;
  family: string;
  name: string;
  defaultSstRate: { toString(): string };
};

type Group = {
  partyId: string;
  unitId: string | null;
  billingMonth: Date | null;
  docType: string;
  counterpartyType: "tenant" | "owner";
  // P4: "" resolves the document's series the default way (via the first line's
  // category — issueDocumentTx's category-routed path); "EB" issues this group on
  // the Expense Bill series instead, via an explicit issueDocumentTx seriesCode
  // override. Every charge in a group shares the SAME routedSeries by construction
  // (it is part of the grouping key below), so no separate consistency check is
  // needed here — mirrors docType, which is likewise embedded in the key and never
  // re-validated per-charge once a charge has joined a group.
  routedSeries: string;
  tenancyId: string | null;
  propertyId: string | undefined;
  apartmentId: string | undefined;
  charges: ChargeForGroup[];
};

/** A charge with no resolvable ChargeCategory — fail-closed (mirrors service.ts's
 * IssuanceError("CATEGORY_UNRESOLVED") contract): nothing is issued rather than
 * guessing a category. Unreachable in the normal grid path (mintItemizedCharges
 * always stamps a real categoryId), but the grouped issuer must not silently
 * skip or default a line just because its category vanished between mint and
 * issue. */
export class GroupedIssuanceCategoryUnresolvedError extends Error {
  readonly code = "CATEGORY_UNRESOLVED";
  constructor(chargeId: string) {
    super(`GroupedIssuanceCategoryUnresolvedError: charge ${chargeId} has no resolvable ChargeCategory`);
    this.name = "GroupedIssuanceCategoryUnresolvedError";
  }
}

/** A group somehow contains charges from BOTH counterparty families (tenant AND
 * owner) — fail-closed rather than mint a mis-routed document. Structurally
 * unreachable once the grouping key is prefixed with counterpartyType (see the
 * key construction in issueGroupedGridInvoiceTx below): a tenant-family charge
 * and an owner-family charge can never resolve to the SAME group. This exists
 * purely as defense-in-depth so a future edit to the key can never silently
 * reintroduce the money-routing hazard a money-routing review found: an
 * owner-borne charge silently merging onto a tenant's invoice (or vice versa)
 * when partyId/unitId/billingMonth/docType happen to collide (e.g. an
 * owner-occupier — not a current KAEN scenario, but not prevented by any code
 * guard). */
export class GroupedIssuanceMixedFamilyError extends Error {
  readonly code = "MIXED_FAMILY_GROUP";
  constructor(partyId: string, unitId: string | null, monthKey: string, docType: string) {
    super(
      `GroupedIssuanceMixedFamilyError: group (partyId=${partyId}, unitId=${unitId ?? "none"}, month=${monthKey}, docType=${docType}) contains charges from more than one counterparty family`,
    );
    this.name = "GroupedIssuanceMixedFamilyError";
  }
}

/** A TENANT Expense-natured charge (nature:"expense" under ENABLE_CHARGE_NATURE_ROUTING)
 * whose destination flag ENABLE_EXPENSE_BILL is OFF. Fail-closed (Task 5,
 * charge-nature-expense-profit-routing): rather than silently mis-book the Expense as
 * ordinary tenant revenue (IVTEN), issuance THROWS and the whole grid-row tx rolls back
 * — nothing minted. Reachable only under a flag MISCONFIGURATION (nature routing ON,
 * Expense Bill OFF), which must never resolve to a revenue line. Like its sibling
 * grouped-issuance errors it extends Error (not IssuanceError), so it surfaces through
 * billService's catch as this row's `save_failed`.
 *
 * There is deliberately NO owner counterpart any more. An owner-borne Expense has a
 * destination that cannot be switched off: it stays an IVOWN line and is netted out of
 * the payout at collection. The old "owner_deduction" arm threw at Bill time whenever
 * nature routing was on without ENABLE_OWNER_BORNE_DEDUCT — a hard failure guarding a
 * model that has since been removed. */
export class ChargeNatureDestinationDisabledError extends Error {
  readonly code = "CHARGE_NATURE_DESTINATION_DISABLED";
  constructor(chargeId: string, destination: "EB") {
    super(
      `ChargeNatureDestinationDisabledError: charge ${chargeId} has nature:"expense" but its destination (${destination}) flag is disabled — refusing to mis-book it as revenue`,
    );
    this.name = "ChargeNatureDestinationDisabledError";
  }
}

export async function issueGroupedGridInvoiceTx(
  tx: Prisma.TransactionClient,
  chargeIds: string[],
  actorUserId: string,
  revision = 0,
): Promise<GroupedGridInvoiceResult> {
  const result: GroupedGridInvoiceResult = { tenantInvoiceIds: [], ownerInvoiceIds: [] };
  if (!chargeIds || chargeIds.length === 0) return result;
  // De-duplicated, first-occurrence-order-preserving. Unreachable via billService in
  // practice (mintItemizedCharges mints a FRESH, unique-per-component id for every
  // charge, so tenantChargeIds/ownerChargeIds can never repeat) — but a repeated id
  // in the input must never double-count that charge's amount as two lines on the
  // same invoice.
  const uniqueChargeIds = [...new Set(chargeIds)];

  const charges: ChargeForGroup[] = await tx.charge.findMany({
    where: { id: { in: uniqueChargeIds } },
    select: {
      id: true,
      organizationId: true,
      partyId: true,
      tenancyId: true,
      unitId: true,
      billingMonth: true,
      categoryId: true,
      description: true,
      amount: true,
      sstRate: true,
      chargeNumber: true,
      chargeType: true,
      sourceGridExpenseId: true,
      nature: true,
      unit: { select: { apartmentId: true, apartment: { select: { propertyId: true } } } },
    },
  });
  if (charges.length === 0) return result;
  // P4: read once — flag OFF short-circuits routedSeries to "" for every charge below,
  // so the grouping/idempotencyKey/issuance is byte-identical to pre-P4 (a tenant
  // expense charge keeps co-grouping onto IVTEN via the default category-routed series).
  const expenseBillOn = isPhase2FlagEnabled("ENABLE_EXPENSE_BILL");
  // Task 5 (charge-nature-expense-profit-routing): read once — flag OFF makes the new
  // `nature` disjunct in isExpenseCharge (below) always false, so isExpenseCharge ===
  // isGridExpenseCharge for every charge and the grouping/idempotency/issuance is
  // byte-identical to pre-Task-5. The fail-closed guard below is likewise inert.
  const natureOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");
  const chargeById = new Map(charges.map((c) => [c.id, c]));
  const orgId = charges[0].organizationId;

  const categoryIds = [...new Set(charges.map((c) => c.categoryId).filter((id): id is string => Boolean(id)))];
  const categories: CategoryForGroup[] = categoryIds.length
    ? await tx.chargeCategory.findMany({
        where: { organizationId: orgId, id: { in: categoryIds } },
        select: { id: true, docType: true, family: true, name: true, defaultSstRate: true },
      })
    : [];
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  // Group by (partyId, unitId, billingMonth, docType), preserving chargeIds'
  // (de-duplicated) input order (insertion order of the Map) so the resulting
  // document's line order is deterministic.
  const groups = new Map<string, Group>();
  for (const chargeId of uniqueChargeIds) {
    const charge = chargeById.get(chargeId);
    if (!charge) continue; // a stale/unknown id — nothing to group or issue for it
    const category = charge.categoryId ? categoryById.get(charge.categoryId) : undefined;
    if (!category) throw new GroupedIssuanceCategoryUnresolvedError(charge.id);

    // counterpartyType is derived from THIS charge's OWN category family — never
    // inherited from another charge — so it can be used both to partition the
    // grouping key below and to fail-closed-guard the group it lands in.
    const counterpartyType: "tenant" | "owner" = category.family === "owner_income" ? "owner" : "tenant";

    // Shared discriminator (P4/P5, accounting-document redesign): a bills-grid expense
    // charge — chargeType "expense" + sourceGridExpenseId set — minted by
    // mintExpenseChargesTx (service.ts), for EITHER bearer. P5 (below) uses it to
    // EXCLUDE an owner-borne expense from IVOWN; P4 (further below) uses it to ROUTE a
    // tenant-borne expense onto its own Expense Bill (EB-) series. Same underlying
    // charge shape, different flag, different downstream fate.
    const isGridExpenseCharge = charge.chargeType === "expense" && charge.sourceGridExpenseId !== null;

    // Task 5 (charge-nature-expense-profit-routing): BROADEN the Expense discriminator.
    // A charge is Expense-natured if it is a bills-grid grid-expense charge (the P4/P5
    // shape above) OR — when ENABLE_CHARGE_NATURE_ROUTING is ON — it carries
    // nature:"expense" regardless of chargeType (e.g. a recurring WiFi/Cleaning line,
    // chargeType "utility", snapshotted nature:"expense" by the mint). Its one remaining
    // downstream fate is the P4 tenant EB reroute (:below) — the owner side no longer
    // branches on nature at all. Flag OFF: the second disjunct is always false (see
    // natureOn above), so isExpenseCharge === isGridExpenseCharge.
    //
    // gridexpense-nature: a PROFIT-natured charge is NEVER expense-routed — it is KAEN
    // revenue that must land on IVTEN via its own category, NOT the tenant Expense Bill.
    // This OVERRIDES isGridExpenseCharge: a freeform GridExpense row (chargeType
    // "expense", sourceGridExpenseId set) marked "profit" would otherwise be force-routed
    // as an expense by isGridExpenseCharge alone. Flag OFF (natureOn false): the profit
    // short-circuit is inert and isExpenseCharge falls through to isGridExpenseCharge.
    const isExpenseCharge = natureOn && charge.nature === "profit"
      ? false
      : isGridExpenseCharge || (natureOn && charge.nature === "expense");

    // Task 5 FAIL-CLOSED (money safety): a TENANT Expense-natured charge whose
    // destination flag (ENABLE_EXPENSE_BILL, P4 reroute below) is off must NEVER fall
    // through and book as ordinary tenant revenue on IVTEN. Throw rather than mis-route —
    // the whole issuance tx rolls back, minting nothing. Reachable only under a flag
    // MISCONFIGURATION (nature routing ON, Expense Bill OFF); inert when natureOn is
    // false. A pre-feature grid-expense charge (nature null) never trips this.
    //
    // The OWNER arm is gone. An owner-borne Expense has no switchable destination any
    // more: it is billed on IVOWN and netted out of the payout at collection, so there is
    // no misconfiguration left to fail closed against.
    if (natureOn && charge.nature === "expense" && counterpartyType === "tenant" && !expenseBillOn) {
      throw new ChargeNatureDestinationDisabledError(charge.id, "EB");
    }

    // P4: a TENANT-borne expense charge routes to its own EB- Expense Bill.
    // "" means "no override — resolve the series the default way, off the line's own
    // category": every non-expense charge, every OWNER-borne expense (always an IVOWN
    // line), and every tenant expense while ENABLE_EXPENSE_BILL is OFF.
    const routedSeries = resolveRoutedSeries({ counterpartyType, isExpenseCharge, expenseBillOn });

    const monthKey = charge.billingMonth ? charge.billingMonth.toISOString().slice(0, 10) : "none";
    // counterpartyType-prefixed: tenant-family and owner-family charges can NEVER
    // land in the same group, regardless of partyId/unitId/billingMonth/docType
    // (money-routing review finding — see GroupedIssuanceMixedFamilyError above).
    // REDESIGN P2 INVARIANT (review panel 2026-07-22): this key groups by docType, NOT
    // category.seriesId — safe ONLY while the grid never mints rental/carpark (now series
    // IVREN; see service.ts "rental deliberately ABSENT"). If a future phase routes a
    // rental/carpark charge through here, ADD category.seriesId to this key AND the
    // idempotencyKey below, else an IVREN "Rental Bill" and a DEP debit-note co-mingle
    // onto one document (whichever is lines[0] wins the series). P4 (below) is a WORKED
    // EXAMPLE of exactly this fix, for a different pair of categories (other_expense_tenant
    // vs electricity_tenant, both docType:"invoice" family:"tenant_income"): `routedSeries`
    // is appended to the key ONLY when non-empty, so the DEFAULT key format (every
    // non-EB-routed charge, flag on or off) stays byte-identical to before, while an
    // EB-routed charge gets a key no ordinary IVTEN charge can ever also produce.
    const key = routedSeries
      ? `${counterpartyType}:${routedSeries}:${charge.partyId}:${charge.unitId ?? "none"}:${monthKey}:${category.docType}`
      : `${counterpartyType}:${charge.partyId}:${charge.unitId ?? "none"}:${monthKey}:${category.docType}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        partyId: charge.partyId,
        unitId: charge.unitId,
        billingMonth: charge.billingMonth,
        docType: category.docType,
        counterpartyType,
        routedSeries,
        tenancyId: charge.tenancyId,
        propertyId: charge.unit?.apartment?.propertyId ?? undefined,
        apartmentId: charge.unit?.apartmentId ?? undefined,
        charges: [],
      };
      groups.set(key, group);
    } else if (group.counterpartyType !== counterpartyType) {
      // Fail-closed guard (defense-in-depth — see class doc above): structurally
      // unreachable given the counterpartyType-prefixed key, but throw rather than
      // silently mint a mis-routed document if this invariant is ever violated.
      throw new GroupedIssuanceMixedFamilyError(group.partyId, group.unitId, monthKey, group.docType);
    }
    group.charges.push(charge);
  }

  for (const group of groups.values()) {
    const ym = group.billingMonth
      ? `${group.billingMonth.getUTCFullYear()}${String(group.billingMonth.getUTCMonth() + 1).padStart(2, "0")}`
      : "000000";
    const unitKey = group.unitId ?? "noUnit";
    // counterpartyType is inserted right after the "grid-doc:" prefix — every
    // OTHER existing component (partyId, unitKey, ym, docType) and the
    // `:r${revision}` suffix are unchanged. Necessary corollary of the
    // counterpartyType-prefixed grouping key above: issueDocumentTx's idempotency
    // dedupe (issue.service.ts) matches on {organizationId, idempotencyKey} ALONE
    // — with no counterpartyType involved — so two groups that legitimately share
    // the SAME (partyId, unitId, ym, docType) (the owner-occupier collision this
    // fix targets) would otherwise compute the IDENTICAL idempotencyKey and the
    // second issueDocumentTx call would dedupe-return the FIRST group's document,
    // silently aliasing the owner invoice onto the tenant's (or vice versa) —
    // defeating the grouping-key fix at the persistence layer. Empirically
    // confirmed: without this segment, ownerInvoiceIds[0] === tenantInvoiceIds[0].
    // P4: `group.routedSeries` (mirrors the grouping key above — appended ONLY when
    // non-empty, so a non-EB-routed group's idempotencyKey is BYTE-IDENTICAL to
    // pre-P4) is the SAME necessary-corollary reasoning applied to the EB case: an
    // EB group and a same-tenant/unit/month/docType IVTEN group would otherwise
    // compute the IDENTICAL idempotencyKey too, and issueDocumentTx's dedupe would
    // alias one onto the other exactly like the owner-occupier case above.
    const seriesSegment = group.routedSeries ? `:${group.routedSeries}` : "";

    // Proforma routing (spec R1): with the flag on, the plain TENANT invoice group is
    // issued as a provisional `proforma` from the PI series. A real invoice is minted
    // from its lines when money arrives (graduation.service.ts).
    //
    // Narrowed to the group that routes nowhere else — not a debit_note (aircond/utility
    // DNs on DEP), not an EB expense recovery. Those keep their own document identity,
    // and it leaves graduation exactly one target series (IVTEN) instead of a routing
    // decision it would have to re-derive later. Owner side untouched (R10).
    const asProforma =
      isPhase2FlagEnabled("ENABLE_PROFORMA_INVOICES")
      && group.counterpartyType === "tenant"
      && group.docType === "invoice"
      && group.routedSeries === "";
    const effectiveDocType = asProforma ? "proforma" : group.docType;

    // effectiveDocType, so a proforma and an invoice for the same (tenant, unit, month)
    // can't collide on issueDocumentTx's idempotency dedupe and alias one onto the other.
    // Flag off ⇒ identical to group.docType ⇒ every existing key unchanged (R12).
    const idempotencyKey = `grid-doc:${group.counterpartyType}${seriesSegment}:${group.partyId}:${unitKey}:${ym}:${effectiveDocType}${revision > 0 ? `:r${revision}` : ""}`;

    const lines = group.charges.map((c) => {
      // Resolved above — every charge in `group.charges` already passed the
      // category-resolution guard before being added to a group.
      const category = categoryById.get(c.categoryId!)!;
      return {
        chargeId: c.id,
        categoryId: c.categoryId!,
        description: c.description ?? category.name,
        amount: c.amount.toString(),
        sstRate: resolveLineSst(c.sstRate, category.defaultSstRate),
        // The SST sibling's amount is tax the BASE line already contributed via its own
        // rate — flagged so issueDocumentTx keeps it out of subtotal and `total` stays
        // exactly what it was before the sibling existed. The line itself still carries
        // `chargeId`, which is what makes the tax visible to deriveDocumentStatus.
        isTax: isExpenseSstChargeNumber(c.chargeNumber),
      };
    });

    const doc = await issueDocumentTx(tx, {
      organizationId: orgId,
      docType: effectiveDocType as "invoice" | "debit_note" | "proforma",
      // P4: an EXPLICIT series override for an EB-routed group — bypasses
      // issueDocumentTx's default category-based series resolution (lines[0]'s
      // category still points at its normal category; only the DOCUMENT's series is
      // redirected). undefined for every other group resolves the series the default
      // way. The OEA branch that used to sit here is gone with
      // ENABLE_OWNER_BORNE_DEDUCT — this path never minted an OEA once
      // resolveRoutedSeries stopped returning one.
      // A proforma always mints from PI — that is what makes a PI- number read as
      // provisional on sight.
      seriesCode: asProforma ? "PI" : group.routedSeries === "EB" ? "EB" : undefined,
      counterpartyType: group.counterpartyType,
      partyId: group.partyId,
      tenancyId: group.tenancyId ?? undefined,
      propertyId: group.propertyId,
      apartmentId: group.apartmentId,
      listingId: group.unitId ?? undefined,
      billingMonth: group.billingMonth ? group.billingMonth.toISOString().slice(0, 10) : undefined,
      idempotencyKey,
      lines,
      actorUserId,
    });

    if (group.counterpartyType === "owner") result.ownerInvoiceIds.push(doc.id);
    else result.tenantInvoiceIds.push(doc.id);
  }

  return result;
}
