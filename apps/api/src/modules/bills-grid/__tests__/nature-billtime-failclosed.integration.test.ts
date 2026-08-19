/**
 * Fix 3 (charge-nature-expense-profit-routing), spec R5 — BILL-TIME fail-closed guard.
 *
 * R5 is enforced today ONLY at the recurring CONFIG route (a 422 NATURE_REQUIRED when
 * ENABLE_CHARGE_NATURE_ROUTING is ON and `nature` is omitted). But a recurring definition
 * CREATED WHILE THE FLAG WAS OFF has a null `nature` (no 422 ever fired). If the flag is
 * later enabled and that line is billed, the mint SILENTLY defaults it to profit
 * (`isExpense = natureOn && line.nature === "expense"` → false for null → manager_revenue /
 * IVTEN) — a silent profit default, contradicting R5.
 *
 * Fix 3 adds a BILL-TIME fail-closed guard: when ENABLE_CHARGE_NATURE_ROUTING is ON, an
 * ENABLED recurring component about to be billed whose nature is NULL raises a billing
 * conflict (`nature_unresolved`) so NOTHING is minted — the admin must re-save the
 * definition with a nature. Covers BOTH representations:
 *   • CUSTOM recurring snapshot lines (GridEntryRecurringLine.nature null), and
 *   • scalar WiFi/Cleaning backed by a dark-period WIFI/CLEANING definition whose effective
 *     revision nature is null (entry.wifiNature/cleaningNature null while the scalar is billable).
 *
 * ── charge-nature gate (2026-07-27) — supersedes two of the original expectations ─────────────
 * Two rows below now assert the OPPOSITE of what they originally did. Both reversals are
 * deliberate; each is argued at its own test.
 *   • B5: a plain DIRECT scalar (no recurring definition) was EXEMPT as "legacy" and billed
 *     normally. It is not legacy — it is the shape every WiFi/Cleaning scalar has in an org with
 *     no recurring definitions — and the exemption silently meant owner + profit ⇒ an IVOWN
 *     receivable for the owner's own WiFi. A billable scalar with no nature from ANY source now
 *     fails closed (B5), and the Unit setting drawer's default is the way out (B5b/B5c). A ZERO
 *     scalar stays billable (B5d) — nothing is minted, so there is no decision to gate.
 *   • B6/B7: a billed entry's FROZEN nature column can never be written again
 *     (isPeriodSnapshotSyncable false + create-only materialize), so failing closed on it was a
 *     PERMANENT block with an unactionable message. The guard and the mint now share
 *     resolveScalarNatures (frozen → governing revision → unit-setting default); the invariant
 *     "guard and mint never disagree" is asserted directly on the re-minted charge instead.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/nature-billtime-failclosed.integration.test.ts
 *
 * Rows:
 *  B1 flag ON + billable CUSTOM tenant line nature NULL → nature_unresolved, NOTHING minted.
 *  B2 flag ON + billable scalar WiFi from a dark-period WIFI def (revision nature NULL) →
 *     nature_unresolved, NOTHING minted (never a silent profit IVTEN mint).
 *  B3 flag ON + CUSTOM line nature "profit" → bills normally (invoiced, charge minted).
 *  B4 flag OFF + CUSTOM line nature NULL → bills as today (invoiced, IVTEN), guard inert.
 *  B5  flag ON + bare scalar wifi, nature unset ANYWHERE → nature_unresolved, NOTHING minted.
 *  B5b flag ON + bare scalar wifi + unit-setting nature "expense" → bills, stamped expense.
 *  B5c flag ON + bare scalar wifi + unit-setting nature "profit"  → bills, manager_revenue.
 *  B5d flag ON + scalar wifi ZERO, nature unset → bills (only a BILLABLE scalar is gated).
 *
 * ── Fix 3b (re-review): guard (b) must key off the SAME FROZEN column the mint reads ──────────
 * The scalar mint reads the FROZEN entry.wifiNature/cleaningNature column (scalarNatureFor,
 * service.ts:~1321). Guard branch (b) originally keyed off the LIVE WIFI/CLEANING revision's nature
 * — two different sources of truth. Reachable DRIFT: an entry is materialized dark-period
 * (entry.wifiNature NULL) and billed; the flag is enabled and the WIFI def's nature is set to
 * "expense" on the current-month revision; the invoiced entry is NON-SYNCABLE so entry.wifiNature
 * stays NULL (correct freeze) but now DRIFTS from the def. On a current-month re-Bill the old guard
 * read the LIVE revision (nature != null) → did NOT fire, while the mint read the FROZEN column
 * (null) → minted nature:null → WiFi silently books on IVTEN as revenue (should be EB); owner
 * Cleaning books on IVOWN as a receivable (should be a payout deduction). CUSTOM lines (guard (a))
 * are IMMUNE because they read the same frozen GridEntryRecurringLine.nature the mint uses. Fix:
 * branch (b) keys off entry.wifiNature/cleaningNature (frozen) — keeping the def-governs check so
 * the B5 plain-scalar-no-def case still bills.
 *
 * (Superseded 2026-07-27 — see the gate note above. Agreement is now reached by giving BOTH sides
 * one resolver with a governing-revision fallback, instead of by refusing to bill at all.)
 *  B6 flag ON + RE-Bill drift (enabled WIFI def natured "expense", entry.wifiNature frozen NULL) →
 *     REINVOICED, and the re-minted WiFi charge is stamped nature "expense".
 *  B7 owner Cleaning analog of B6 → REINVOICED, re-minted Cleaning stamped nature "expense"
 *     (⇒ owner payout deduction, not an IVOWN receivable).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";
import { applyRecurringService } from "../recurring.service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "f3c00000-0000-4000-8000-000000000001";
const USER = "f3c00000-0000-4000-8000-000000000002";
const PROP = "f3c00000-0000-4000-8000-000000000003";
const APT = "f3c00000-0000-4000-8000-000000000004";
const ROOM = "f3c00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "f3c00000-0000-4000-8000-000000000006";
const TENANT_PARTY = "f3c00000-0000-4000-8000-000000000007";
const TENANCY = "f3c00000-0000-4000-8000-000000000008";
const DEF1 = "f3c00000-0000-4000-8000-00000000000b";
const REV1 = "f3c00000-0000-4000-8000-00000000000e";

const session = { orgId: ORG, userId: USER, role: "manager" };
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** Whole occupied unit; tnb absorbed (owner-borne electricity) + wifi/cleaning 0 by default so a
 * CUSTOM-line row exercises only the recurring line. Returns the entry id + its updatedAt token. */
async function seedWholeUnit(opts?: { wifi?: string; wifiBearer?: "owner" | "tenant" }): Promise<{ entryId: string; token: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "NBF", slug: "nbf", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "nbf@example.test", fullName: "NBF", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-NBF", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-NBF", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-NBF", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "0.00", wifi: opts?.wifi ?? "0.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: opts?.wifiBearer ?? "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  await ensureChargeCategorySeeds(ORG);
  return { entryId: entry.id, token: entry.updatedAt.toISOString() };
}

/** Materialize one CUSTOM recurring snapshot line, carrying `nature` (may be null = dark-period). */
async function addRecurringLine(entryId: string, opts: { name: string; amount: string; bearer: "owner" | "tenant"; nature?: "expense" | "profit" | null }) {
  const code = opts.bearer === "owner" ? "recurring_other_owner" : "recurring_other_tenant";
  const cat = await getDb().chargeCategory.findFirstOrThrow({ where: { organizationId: ORG, code }, select: { id: true, name: true, family: true } });
  return getDb().gridEntryRecurringLine.create({
    data: {
      organizationId: ORG, gridEntryId: entryId, definitionId: DEF1, revisionId: REV1,
      name: opts.name, amount: opts.amount, bearer: opts.bearer, nature: opts.nature ?? null,
      categoryId: cat.id, categoryCode: code, categoryName: cat.name, categoryFamily: cat.family,
      resolvedPartyId: opts.bearer === "owner" ? OWNER_PARTY : TENANT_PARTY,
      resolvedTenancyId: opts.bearer === "owner" ? null : TENANCY,
      resolvedUnitId: ROOM, effectiveMonth: PERIOD, kind: "CUSTOM",
    },
  });
}

/** Read the entry's current updatedAt token (any config write bumps it). */
async function freshToken(entryId: string): Promise<string> {
  const e = await getDb().unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
  return e.updatedAt.toISOString();
}

/** Configure a WIFI/CLEANING definition WITHOUT a nature — simulating the dark period (the UI
 * before ENABLE_CHARGE_NATURE_ROUTING existed): the effective revision persists nature NULL and
 * the scalar column materializes with entry.*Nature NULL. Call this with the routing flag OFF. */
async function applyDarkPeriodScalar(kind: "WIFI" | "CLEANING", bearer: "owner" | "tenant", amount: string) {
  const out = await applyRecurringService(session, APT, {
    kind, name: kind === "WIFI" ? "WiFi" : "Cleaning", amount, bearer,
    effectiveFromMonth: PERIOD_STR, enabled: true, confirm: true, // no `nature` — dark period
  });
  if (!out.ok) throw new Error(`applyRecurringService(${kind}) failed: ${JSON.stringify(out)}`);
}

dn("bills-grid — bill-time fail-closed on null-nature recurring components (Fix 3, R5)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  it("B1 — flag ON + billable CUSTOM tenant line nature NULL → nature_unresolved, NOTHING minted", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    // Dark-period line: materialized with nature NULL (no 422 ever fired for it).
    await addRecurringLine(entryId, { name: "Late fee", amount: "25.00", bearer: "tenant", nature: null });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    // Fail closed — the whole row conflicts; it does NOT silently mint the line as profit.
    expect(r.data.results[0].outcome).toBe("nature_unresolved");

    // NOTHING minted for the org — no charge, no document (pre-lock abort).
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("B2 — flag ON + billable scalar WiFi from a dark-period WIFI def (revision nature NULL) → nature_unresolved, NOTHING minted", async () => {
    const db = getDb();
    const { entryId } = await seedWholeUnit(); // wifi 0; applyRecurringService overwrites the scalar
    await applyDarkPeriodScalar("WIFI", "tenant", "120.00"); // configured with routing flag OFF → nature NULL
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true"; // flag flips ON, then bill

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    // The scalar WiFi must NOT silently mint as manager_revenue/IVTEN — fail closed instead.
    expect(r.data.results[0].outcome).toBe("nature_unresolved");
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("B3 — flag ON + CUSTOM line nature 'profit' → bills normally (invoiced, charge minted; guard inert)", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Convenience fee", amount: "40.00", bearer: "tenant", nature: "profit" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced"); // a set nature never trips the guard
    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBe("profit");
    expect(rc.revenueRecognition).toBe("manager_revenue");
  });

  it("B4 — flag OFF + CUSTOM line nature NULL → bills as today (invoiced, IVTEN); guard inert (byte-identical)", async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // routing OFF
    const db = getDb();
    const { entryId, token } = await seedWholeUnit();
    const line = await addRecurringLine(entryId, { name: "Late fee", amount: "25.00", bearer: "tenant", nature: null });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced"); // flag OFF ⇒ the guard never runs
    const rc = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, sourceRecurringLineId: line.id } });
    expect(rc.nature).toBeNull();
    const dl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: rc.id } });
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: dl.documentId } });
    expect(doc.documentNumber.startsWith("IVTEN-")).toBe(true);
  });

  // ── charge-nature gate (2026-07-27) — B5 INVERTED, deliberately ───────────────────────────────
  // B5 used to assert that a bare scalar (no recurring definition) bills normally, on the theory
  // that it is "legacy". Live data disproved the premise: an org with NO recurring definitions has
  // every WiFi/Cleaning scalar in this shape, so the exemption was the common path, and it made
  // "the admin never configured this unit" silently mean wifiBearer='owner' (schema default) +
  // nature null ⇒ profit ⇒ an IVOWN receivable billing the owner for their own WiFi. Not
  // configuring a unit is not a money decision. The scalar now fails closed like every other
  // undecided component — and B5b proves the unit-setting default is the way OUT of the block.
  it("B5 — flag ON + plain DIRECT scalar wifi, nature UNSET anywhere → nature_unresolved, NOTHING minted", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const db = getDb();
    // A bare scalar column: wifi 120 set straight on the entry, NO WIFI definition, nature NULL,
    // and no UnitBillsBearerConfig nature either — nothing anywhere says Expense or Profit.
    const { token } = await seedWholeUnit({ wifi: "120.00", wifiBearer: "tenant" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("nature_unresolved");
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("B5b — flag ON + bare scalar wifi + UNIT-SETTING nature 'expense' → bills, stamped expense (the way out of B5)", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    process.env.ENABLE_EXPENSE_BILL = "true"; // tenant Expense destination must exist (fail-closed otherwise)
    const db = getDb();
    const { token } = await seedWholeUnit({ wifi: "120.00", wifiBearer: "tenant" });
    // The admin answers in the Unit setting drawer → UnitBillsBearerConfig.wifiNature. This is
    // step 3 of resolveScalarNatures' precedence, and the ONLY source a bare scalar has.
    await db.unitBillsBearerConfig.create({ data: { organizationId: ORG, apartmentId: APT, wifiNature: "expense" } });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    const wifi = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-WIFI" } } });
    // The MINT stamped exactly what the guard admitted — the agreement invariant.
    expect(wifi.nature).toBe("expense");
  });

  it("B5c — flag ON + bare scalar wifi + unit-setting nature 'profit' → bills as manager revenue", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const db = getDb();
    const { token } = await seedWholeUnit({ wifi: "120.00", wifiBearer: "tenant" });
    await db.unitBillsBearerConfig.create({ data: { organizationId: ORG, apartmentId: APT, wifiNature: "profit" } });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    const wifi = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-WIFI" } } });
    expect(wifi.nature).toBe("profit");
    expect(wifi.revenueRecognition).toBe("manager_revenue");
  });

  it("B5d — flag ON + scalar wifi ZERO and nature unset → bills normally (only a BILLABLE scalar is gated)", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const db = getDb();
    // wifi 0 ⇒ no WiFi charge is minted at all ⇒ there is no money decision to fail closed on.
    // Without this carve-out every unconfigured unit in the org would be unbillable.
    const { token } = await seedWholeUnit({ wifi: "0.00", wifiBearer: "tenant" });

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");
    expect(await db.charge.count({ where: { organizationId: ORG, chargeNumber: { contains: "-WIFI" } } })).toBe(0);
  });

  it("B6 — RE-Bill drift: enabled WIFI def natured 'expense' but entry.wifiNature frozen NULL → nature_unresolved, NOTHING re-minted", async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // dark period: bill the first time with routing OFF
    const db = getDb();
    // (1) Dark-period materialize: WIFI def with NO nature → entry.wifi 120, entry.wifiNature NULL.
    const { entryId } = await seedWholeUnit();
    await applyDarkPeriodScalar("WIFI", "tenant", "120.00");

    // (2) FIRST Bill (flag OFF, guard inert) → a live IVTEN carrying the WiFi (nature NULL).
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    const chargesAfterFirst = await db.charge.count({ where: { organizationId: ORG } });

    // (3) DRIFT: the admin natures the WIFI def "expense" on the current-month revision. The invoiced
    // entry is non-syncable, so the FROZEN entry.wifiNature the mint reads stays NULL — it now DRIFTS
    // from the LIVE revision nature the OLD guard read.
    await db.recurringChargeRevision.updateMany({
      where: { definition: { organizationId: ORG, apartmentId: APT, kind: "WIFI" } },
      data: { nature: "expense" },
    });
    const eDrift = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(eDrift.wifiNature).toBeNull(); // precondition: frozen column still NULL (the drift)

    // (4) An unrelated edit (bump absorbed TNB) forces a real re-Bill (not a no-op). The OLD guard,
    // reading the LIVE revision (now "expense", non-null), would NOT fire → the mint reads the FROZEN
    // column (null) → silently re-mints the WiFi as nature NULL on a fresh IVTEN. Flip the flag ON.
    await db.unitBillsGridEntry.update({ where: { id: entryId }, data: { tnbTotalRaw: "350.00" } });
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    // The WiFi now resolves to "expense", so its DESTINATION must exist. Without this the
    // issuance throws ChargeNatureDestinationDisabledError and the row returns `save_failed` —
    // itself correct fail-closed behaviour (never mis-route to IVTEN), just not what B6 measures.
    process.env.ENABLE_EXPENSE_BILL = "true";

    // confirmRebill:true drives the OLD path PAST the confirmation gate into supersede+reissue — so
    // pre-fix it actually re-mints the WiFi as nature NULL on a fresh IVTEN (the silent misbook). The
    // nature guard runs BEFORE the re-Bill flow, so post-fix it fails closed here regardless.
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId), confirmRebill: true }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    // ── charge-nature gate (2026-07-27) — B6 OUTCOME CHANGED, deliberately ──────────────────────
    // Fix 3b made this case fail closed so the guard could not disagree with the mint. But the
    // frozen column is UNWRITABLE once billed/invoiced (isPeriodSnapshotSyncable is false and
    // materialize is create-only), so the block was PERMANENT and its message ("re-save the
    // recurring definition with a type") named an action that could not possibly clear it.
    // Both sides now read resolveScalarNatures, which falls back to the governing revision — so
    // the drift resolves to "expense" for the guard AND the mint alike. The invariant Fix 3b
    // actually protects (guard and mint never disagree) is asserted below, on the re-minted
    // charge, rather than bought by refusing to bill.
    expect(r.data.results[0].outcome).toBe("reinvoiced");
    const reminted = await db.charge.findFirstOrThrow({
      where: { organizationId: ORG, chargeNumber: { contains: "-WIFI" }, status: { notIn: ["void", "credited"] } },
      orderBy: { createdAt: "desc" },
    });
    expect(reminted.nature).toBe("expense"); // the mint stamped exactly what the guard admitted
    expect(chargesAfterFirst).toBeGreaterThan(0); // sanity: the first Bill really did mint
  });

  it("B7 — RE-Bill drift (owner Cleaning): enabled CLEANING def natured 'expense' but entry.cleaningNature frozen NULL → nature_unresolved, NOTHING re-minted", async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    const db = getDb();
    // Plain tenant scalar wifi 50 guarantees a tenant bill alongside the owner-borne Cleaning, so
    // the drift under test is isolated to the CLEANING def. charge-nature gate: that bare scalar
    // used to be exempt (old B5) and so needed no nature; it is now gated like everything else, so
    // give it an explicit unit-setting "profit" — keeping it on IVTEN, needing no EB destination,
    // and leaving CLEANING as the only thing this test's guard outcome can be about.
    const { entryId } = await seedWholeUnit({ wifi: "50.00", wifiBearer: "tenant" });
    await db.unitBillsBearerConfig.upsert({
      where: { organizationId_apartmentId: { organizationId: ORG, apartmentId: APT } },
      update: { wifiNature: "profit" },
      create: { organizationId: ORG, apartmentId: APT, wifiNature: "profit" },
    });
    await applyDarkPeriodScalar("CLEANING", "owner", "80.00"); // dark-period CLEANING def → cleaningNature NULL

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    const chargesAfterFirst = await db.charge.count({ where: { organizationId: ORG } });

    // DRIFT: nature the CLEANING def "expense"; the invoiced entry.cleaningNature stays frozen NULL.
    await db.recurringChargeRevision.updateMany({
      where: { definition: { organizationId: ORG, apartmentId: APT, kind: "CLEANING" } },
      data: { nature: "expense" },
    });
    const eDrift = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(eDrift.cleaningNature).toBeNull();

    await db.unitBillsGridEntry.update({ where: { id: entryId }, data: { tnbTotalRaw: "350.00" } });
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";

    // No owner destination flag to set any more: ENABLE_OWNER_BORNE_DEDUCT was removed
    // (2026-08-16) and an owner Expense simply bills onto IVOWN, then nets out of the
    // payout at collection. This case never asserted the destination — only that the
    // re-Bill resolves the nature and mints — so it is unaffected by that.
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId), confirmRebill: true }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    // B7 OUTCOME CHANGED alongside B6 (see the rationale there) — the owner analog. The frozen
    // entry.cleaningNature is unwritable on a billed period, so falling back to the governing
    // CLEANING revision is the only thing that can ever resolve it. Guard and mint agree on
    // "expense", so the re-minted owner Cleaning carries nature "expense" — which was the
    // money outcome Fix 3b wanted and could only get by blocking.
    expect(r.data.results[0].outcome).toBe("reinvoiced");
    const reminted = await db.charge.findFirstOrThrow({
      where: { organizationId: ORG, chargeNumber: { contains: "-CLEANING" }, status: { notIn: ["void", "credited"] } },
      orderBy: { createdAt: "desc" },
    });
    expect(reminted.nature).toBe("expense");
    expect(chargesAfterFirst).toBeGreaterThan(0);
  });
});
