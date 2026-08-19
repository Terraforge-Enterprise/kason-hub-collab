import type { z } from "zod";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { rentInvoiceStartToUtcDate, resolveDepositBasisRate } from "@kason/shared";
import type { TenancySession } from "./tenancy.types";
import {
  createLandlordTenancy,
  findLandlordTenancy,
  findOwnerRole,
  findProperty,
  findReservationRent,
  findTenantRole,
  findTenancy,
  findTenancyByCode,
  findUnit,
  listLandlordTenancies,
  listTenancies,
  renewTenancyTx,
  updateLandlordTenancy,
  updateTenancy,
} from "./tenancy.repository";
import { markUnitOccupiedForTenancyTx } from "../inventory/occupancy-tenancy-sync";
import { assertCommissionWritable } from "./commission-guard";
import {
  createLandlordTenancySchema,
  createTenancySchema,
  renewTenancySchema,
  updateLandlordTenancyStatusSchema,
  updateTenancySchema,
} from "./tenancy.validation";
import { dashboardCache } from "../../lib/cache";
import { assignCarparksTx, releaseAssignmentsForTenancyTx } from "../carpark/carpark-assignment.service";
import { assertNoActiveTenancyTx } from "./active-tenancy-guard";
import { generateTenancyCodeTx } from "./tenancy-code-generator";
import { mapTenancyP2002 } from "./tenancy-p2002";
import { recordAudit } from "../../lib/audit";
import { draftCatchupForTenancy } from "../billing/draft-catchup.hook";
import { createTenancyDepositsForTenancy } from "../billing/tenancy-deposits";

// Wave-2 review #2: writing the rent-invoice schedule (start date / first-month
// note) controls WHEN rent invoices fire, so it is money-adjacent and must leave
// an in-transaction audit trail. This shapes the audit `meta` from the values
// actually being written (the stored UTC-day Date + the free-text note).
function invoiceScheduleAuditMeta(
  rentInvoiceStartDate: Date | null,
  firstMonthRentNote: string | null | undefined,
) {
  return {
    rentInvoiceStartDate: rentInvoiceStartDate ? rentInvoiceStartDate.toISOString() : null,
    firstMonthRentNote: firstMonthRentNote ?? null,
  };
}

export async function getLandlordTenanciesService(session: TenancySession) {
  return listLandlordTenancies(session.orgId);
}

export async function createLandlordTenancyService(session: TenancySession, input: z.infer<typeof createLandlordTenancySchema>) {
  const [property, ownerRole] = await Promise.all([
    findProperty(session.orgId, input.propertyId),
    findOwnerRole(session.orgId, input.landlordId),
  ]);
  if (!property) return { ok: false as const, status: 404, error: "Property not found" };
  if (!ownerRole) return { ok: false as const, status: 404, error: "Landlord owner record not found" };

  const monthlyRent = Number(input.monthlyRent);
  if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) return { ok: false as const, status: 400, error: "Monthly rent must be a valid positive amount" };

  const depositAmount = input.depositAmount ? Number(input.depositAmount) : null;
  if (input.depositAmount && (!Number.isFinite(depositAmount) || (depositAmount ?? 0) < 0)) {
    return { ok: false as const, status: 400, error: "Deposit amount must be a valid non-negative amount" };
  }

  const created = await createLandlordTenancy({
    organizationId: session.orgId,
    propertyId: input.propertyId,
    landlordId: input.landlordId,
    startDate: new Date(input.startDate),
    endDate: input.endDate ? new Date(input.endDate) : null,
    monthlyRent,
    depositAmount,
    status: input.status || "active",
    notes: input.notes || null,
  });

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  return { ok: true as const, status: 201, data: created };
}

export async function updateLandlordTenancyStatusService(session: TenancySession, input: z.infer<typeof updateLandlordTenancyStatusSchema>) {
  const existing = await findLandlordTenancy(session.orgId, input.landlordTenancyId);
  if (!existing) return { ok: false as const, status: 404, error: "Landlord tenancy not found" };

  await updateLandlordTenancy(input.landlordTenancyId, {
    status: input.status,
    ...(input.endDate !== undefined ? { endDate: input.endDate ? new Date(input.endDate) : null } : {}),
    ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
  });

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  return { ok: true as const, status: 200, data: { id: input.landlordTenancyId } };
}

export async function getTenanciesService(session: TenancySession) {
  return listTenancies(session.orgId);
}

export async function createTenancyService(session: TenancySession, input: z.infer<typeof createTenancySchema>) {
  const [property, unit, tenantRole, duplicateCode] = await Promise.all([
    findProperty(session.orgId, input.propertyId),
    findUnit(session.orgId, input.unitId),
    findTenantRole(session.orgId, input.tenantPartyId),
    // MUST stay conditional. findTenancyByCode(orgId, undefined) builds a Prisma
    // findFirst with NO tenancyCode filter, so it matches the org's FIRST tenancy
    // and 409s "Tenancy code already exists" on an otherwise valid auto-code
    // create. Nothing to pre-check when the server is the one minting the code.
    input.tenancyCode ? findTenancyByCode(session.orgId, input.tenancyCode) : Promise.resolve(null),
  ]);

  if (!property) return { ok: false as const, status: 404, error: "Property not found" };
  if (!unit || unit.propertyId !== input.propertyId) return { ok: false as const, status: 404, error: "Unit not found in selected property" };
  if (!unit.ownerPartyId) {
    return { ok: false as const, status: 409, code: "UNIT_HAS_NO_OWNER" as const, error: "This unit has no assigned owner. Assign an owner before creating a tenancy." };
  }
  if (!tenantRole) return { ok: false as const, status: 404, error: "Tenant record not found" };
  if (duplicateCode) return { ok: false as const, status: 409, error: "Tenancy code already exists" };

  let monthlyRentSource = input.monthlyRentAmount;
  if (input.reservationId) {
    const resRent = await findReservationRent(session.orgId, input.reservationId);
    if (!resRent) return { ok: false as const, status: 404, error: "Reservation not found or has no agreed rent" };
    // Mirror convert's status gate (T14-fix2): only a SIGNED reservation may
    // seed a tenancy -- otherwise a cancelled/expired reservation still
    // linked to a tenant could seed rent via this path.
    if (resRent.status && resRent.status !== "signed") {
      return { ok: false as const, status: 400, code: "RESERVATION_NOT_SIGNED" as const, error: "Reservation must be signed before it can become a tenancy" };
    }
    // Defense-in-depth (mirrors convertReservationToTenancy, T14): a reservation
    // created FROM a specific tenant (tenantPartyId) may only seed a tenancy for
    // that SAME tenant -- otherwise a direct API caller could write this
    // reservation's negotiated rent onto an unrelated tenant. Null link
    // (legacy/direct reservation) falls through unchanged.
    if (resRent.tenantPartyId && resRent.tenantPartyId !== input.tenantPartyId) {
      return { ok: false as const, status: 422, code: "RESERVATION_TENANT_MISMATCH" as const, error: "Reservation is linked to a different tenant" };
    }
    // One reservation -> one tenancy (mirrors convert's RESERVATION_ALREADY_CONVERTED).
    // Placed before the unit-consistency check below so an already-converted
    // reservation always reports RESERVATION_ALREADY_CONVERTED (its most
    // specific, identity-based reason) rather than a unit mismatch that may
    // only be incidental to reusing the same reservation id.
    const alreadyConverted = await getDb().tenancy.findFirst({
      where: { organizationId: session.orgId, reservationId: input.reservationId },
      select: { id: true },
    });
    if (alreadyConverted) {
      return {
        ok: false as const,
        status: 409,
        code: "RESERVATION_ALREADY_CONVERTED" as const,
        error: "Reservation already converted",
        existingTenancyId: alreadyConverted.id,
      };
    }
    // Unit-consistency (T14-fix2): a reservation's negotiated rent may only bind
    // to the unit it was signed for. Convert forces unitId = r.unitId; this
    // path takes input.unitId verbatim, so without this guard a reservation
    // signed for unit U1 could seed a tenancy on a DIFFERENT unit U2 while
    // applying U1's negotiated rent and stamping this reservation's id.
    if (resRent.unitId && resRent.unitId !== input.unitId) {
      return { ok: false as const, status: 422, code: "RESERVATION_UNIT_MISMATCH" as const, error: "Reservation is for a different unit" };
    }
    monthlyRentSource = resRent.agreedMonthlyRent; // reservation wins
  }
  const monthlyRent = Number(monthlyRentSource);
  if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) return { ok: false as const, status: 400, error: "Monthly rent must be a valid positive amount" };

  const suppliedDeposit = input.depositAmount ? Number(input.depositAmount) : null;
  if (input.depositAmount && (!Number.isFinite(suppliedDeposit) || (suppliedDeposit ?? 0) < 0)) {
    return { ok: false as const, status: 400, error: "Deposit amount must be a valid non-negative amount" };
  }
  // The Assign-to-Unit dialog no longer carries a free-text deposit box — it was a
  // second, conflicting source of truth for a figure the unit already defines. The
  // owner statement still reads Tenancy.depositAmount (to show the deposit, and to
  // back-compute depositMonths as round(depositAmount / monthlyRentAmount)), so
  // derive it here when the caller omits one.
  //
  // Basis is the RENTAL leg only, on the same rate tenancy-deposits.ts bills the
  // DEPRENT charge at, so the stored figure, the tenant's bill and the owner's
  // statement all agree. Folding in utilitiesDepositMonths would break the
  // statement's back-computation (2 + 0.5 months would report as 3).
  //
  // A null or zero depositMonths stays null — NOT defaulted to 2. That mirrors
  // tenancy-deposits.ts: the web form's default is a data-entry convenience, and
  // inventing a figure nobody keyed in would show the owner a deposit that was
  // never agreed and that no DEPRENT charge backs.
  const depositMonths = unit.depositMonths;
  const depositBasis = resolveDepositBasisRate({
    tenancyMonthlyRent: monthlyRent,
    rentalRate: unit.rentalRate,
  });
  const depositAmount =
    suppliedDeposit ??
    (depositMonths != null && depositMonths > 0 && depositBasis != null && depositBasis > 0
      ? Math.round(depositBasis * depositMonths * 100) / 100
      : null);

  const startDate = new Date(input.startDate);
  const rentInvoiceStartDate = rentInvoiceStartToUtcDate(input.rentInvoiceStartDate);
  // Wave-2 review #1 (create-path guard): the schema refiner only enforces
  // invoice-start >= move-in when startDate is ISO-leading (YYYY-MM-DD...). A
  // non-ISO startDate (e.g. "July 1, 2026") makes the refiner skip the
  // cross-field check, so a pre-move-in invoice start could slip through on the
  // API. Re-check against the parsed move-in day (UTC calendar day) before
  // writing -- mirrors updateTenancyService. This never rejects an ISO input the
  // refiner already passed: the refiner compares the LEADING calendar day, which
  // east of UTC is >= this UTC day.
  if (rentInvoiceStartDate && !Number.isNaN(startDate.getTime())) {
    const moveInUtc = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
    if (rentInvoiceStartDate.getTime() < moveInUtc) {
      return { ok: false as const, status: 400, error: "Rental invoicing cannot start before the move-in date" };
    }
  }
  // Whether this create actually sets a rent-invoice schedule -- drives the
  // in-transaction audit (Wave-2 review #2). A plain tenancy with no schedule
  // keeps its existing (untransactioned) create shape.
  const hasInvoiceSchedule =
    rentInvoiceStartDate != null || (input.firstMonthRentNote ?? null) != null;

  const createChangesCommission =
    input.firstMonthIsCommission === true || (input.commissionSstBearer !== undefined && input.commissionSstBearer !== "owner");
  const createGuard = await assertCommissionWritable(session, createChangesCommission, null);
  if (!createGuard.ok) return { ok: false as const, status: createGuard.status, error: createGuard.error, code: createGuard.code };

  const tenancyData = {
    organizationId: session.orgId,
    propertyId: input.propertyId,
    unitId: input.unitId,
    tenantPartyId: input.tenantPartyId,
    status: "active",
    billingStatus: input.billingStatus || "active",
    startDate,
    endDate: input.endDate ? new Date(input.endDate) : null,
    monthlyRentAmount: monthlyRent,
    depositAmount,
    // Wave-2 #1/#3: persist the rent-invoice fields (previously accepted by the
    // schema then silently dropped). rentInvoiceStartDate is stored as UTC
    // midnight of the calendar day so a UTC-day invoice compare never drifts a
    // month on the UTC+8 server. Invoice-start >= move-in is enforced by the
    // schema refiner (ISO startDate) AND the service guard above (non-ISO).
    rentInvoiceStartDate,
    firstMonthRentNote: input.firstMonthRentNote ?? null,
    firstMonthIsCommission: input.firstMonthIsCommission ?? false,
    commissionSstBearer: input.commissionSstBearer ?? "owner",
    reservationId: input.reservationId,
  };

  // Resolves the tenancy code INSIDE the caller's transaction: an explicit code
  // wins, otherwise the shared TEN-{year}-NNNN generator runs against that same
  // tx, so its max-scan and the insert can never straddle a commit boundary.
  // The generator is still read-then-write, so the (organizationId, tenancyCode)
  // unique index + mapTenancyP2002 stay the authoritative race backstop
  // (-> TENANCY_CODE_TAKEN). Mirrors convertReservationToTenancy's `?? generate`.
  // Every create branch below MUST build its insert payload through this — a
  // branch that spreads bare `tenancyData` would insert a null code.
  const buildTenancyData = async (tx: Prisma.TransactionClient) => ({
    ...tenancyData,
    tenancyCode: input.tenancyCode ?? (await generateTenancyCodeTx(tx, session.orgId)),
  });

  // Unit-free guard (R7/R8, mirrors convertReservationToTenancy's T7 guard):
  // a plain read here, NOT yet inside a transaction -- if the unit is free,
  // or an incumbent exists but overwrite isn't requested, no write happens
  // below and there's nothing to protect atomically.
  const active = await assertNoActiveTenancyTx(getDb(), session.orgId, input.unitId);

  if (active && !input.overwrite) {
    const inc = await getDb().tenancy.findFirst({
      where: { id: active.id },
      select: { endDate: true, tenantParty: { select: { displayName: true } } },
    });
    return {
      ok: false as const,
      status: 409,
      code: "UNIT_HAS_ACTIVE_TENANCY" as const,
      error: "Unit already has an active tenancy",
      incumbent: {
        tenantName: inc?.tenantParty?.displayName ?? "current tenant",
        endDate: inc?.endDate ?? null,
      },
    };
  }

  if (active && input.overwrite) {
    // Overwrite: close the incumbent + create the new tenancy (+carparks)
    // atomically in ONE transaction. The active-tenancy check is re-run
    // INSIDE the transaction (authoritative -- guards a race where the
    // incumbent changed between the read above and here) so the close-out
    // and the new create can never observe different "current incumbent"
    // rows.
    try {
      const txResult = await getDb().$transaction(async (tx) => {
        const activeInTx = await assertNoActiveTenancyTx(tx, session.orgId, input.unitId);
        let previousTenancyId: string | undefined;
        if (activeInTx) {
          // A superseded tenancy can't end before it began: clamp to its own
          // start when the incoming startDate predates it.
          const supersededEndDate =
            tenancyData.startDate >= activeInTx.startDate ? tenancyData.startDate : activeInTx.startDate;
          await tx.tenancy.update({
            where: { id: activeInTx.id },
            data: { status: "ended", endDate: supersededEndDate },
          });
          await releaseAssignmentsForTenancyTx(tx, session.orgId, activeInTx.id, supersededEndDate);
          previousTenancyId = activeInTx.id;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const created = await (tx as any).tenancy.create({
          data: { ...(await buildTenancyData(tx)), previousTenancyId },
          select: { id: true },
        });
        // Flip the unit occupied UNCONDITIONALLY here — every path that reaches
        // this create leaves an active tenancy on the unit, whether or not an
        // incumbent was found to close (a stale-read race can null activeInTx).
        // moveInDate is the NEW tenancy's startDate, never the clamped
        // supersededEndDate above.
        await markUnitOccupiedForTenancyTx(tx, session.orgId, input.unitId, tenancyData.startDate);

        if (input.carparks?.length) {
          const assignResult = await assignCarparksTx(tx, session, created.id, input.propertyId, input.carparks!);
          if (!assignResult.ok) {
            throw Object.assign(new Error(assignResult.error), { _carparkStatus: assignResult.status });
          }
        }

        // T9 review Finding 2: closing the incumbent (status=ended + bay
        // release, above) is a money-material lease termination -- audit it
        // in the SAME transaction, mirroring convertReservationToTenancy's
        // supersession audit row.
        await recordAudit(tx, {
          organizationId: session.orgId,
          actorUserId: session.userId,
          actorRole: session.role,
          action: "tenancy.manual_overwrite",
          entityType: "Tenancy",
          entityId: created.id,
          meta: { supersededTenancyId: previousTenancyId ?? null },
        });

        // Wave-2 review #2: an invoice schedule set at creation is money-adjacent
        // -- audit it in the SAME transaction alongside the create.
        if (hasInvoiceSchedule) {
          await recordAudit(tx, {
            organizationId: session.orgId,
            actorUserId: session.userId,
            actorRole: session.role,
            action: "tenancy.invoice_schedule_set",
            entityType: "Tenancy",
            entityId: created.id,
            meta: invoiceScheduleAuditMeta(rentInvoiceStartDate, input.firstMonthRentNote),
          });
        }

        return { ok: true as const, status: 201 as const, data: created };
      });
      dashboardCache.invalidate(`dashboard:${session.orgId}`);
      // Post-commit, never-throws: a tenancy created after this period's draft
      // run missed the cohort — draft its rent invoice into the approval queue.
      await draftCatchupForTenancy(session, txResult.data.id);
      // Separate hook, NOT folded into the one above: rent drafting is gated on
      // ENABLE_PHASE2_AUTODRAFT + DraftConfig.includeRent, and "this org bills rent
      // by hand" must not also mean "this org collects no deposits".
      await createTenancyDepositsForTenancy(session, txResult.data.id);
      return txResult;
    } catch (e) {
      const ce = e as { _carparkStatus?: number; message?: string };
      if (typeof ce._carparkStatus === "number") {
        return { ok: false as const, status: ce._carparkStatus, error: ce.message ?? "Carpark assignment failed" };
      }
      const mapped = mapTenancyP2002(e);
      if (mapped) return { ok: false as const, ...mapped };
      throw e;
    }
  }

  if (input.carparks?.length) {
    // Atomic: wrap tenancy create + carpark assignment in ONE transaction so that
    // any bay failure (wrong building, already rented, P2002 race) rolls the
    // entire transaction back — no orphan tenancy row is left behind.
    let txResult: { ok: true; status: 201; data: { id: string } } | { ok: false; status: number; error: string };
    try {
      txResult = await getDb().$transaction(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const created = await (tx as any).tenancy.create({ data: await buildTenancyData(tx), select: { id: true } });
        await markUnitOccupiedForTenancyTx(tx, session.orgId, input.unitId, tenancyData.startDate);
        // Wave-2 review #2: an invoice schedule set at creation is money-adjacent
        // -- audit it in the SAME transaction alongside the create + assignment.
        if (hasInvoiceSchedule) {
          await recordAudit(tx, {
            organizationId: session.orgId,
            actorUserId: session.userId,
            actorRole: session.role,
            action: "tenancy.invoice_schedule_set",
            entityType: "Tenancy",
            entityId: created.id,
            meta: invoiceScheduleAuditMeta(rentInvoiceStartDate, input.firstMonthRentNote),
          });
        }
        const assignResult = await assignCarparksTx(
          tx,
          session,
          created.id,
          input.propertyId,
          input.carparks!,
        );
        if (!assignResult.ok) {
          // Throw to trigger transaction rollback; caught and unwrapped below.
          throw Object.assign(new Error(assignResult.error), {
            _carparkStatus: assignResult.status,
          });
        }
        return { ok: true as const, status: 201 as const, data: created };
      });
    } catch (e) {
      const ce = e as { _carparkStatus?: number; message?: string };
      if (typeof ce._carparkStatus === "number") {
        return { ok: false as const, status: ce._carparkStatus, error: ce.message ?? "Carpark assignment failed" };
      }
      const mapped = mapTenancyP2002(e);
      if (mapped) return { ok: false as const, ...mapped };
      throw e;
    }
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    // Post-commit, never-throws: see the overwrite branch above.
    if (txResult.ok) await draftCatchupForTenancy(session, txResult.data.id);
    if (txResult.ok) await createTenancyDepositsForTenancy(session, txResult.data.id);
    return txResult;
  }

  try {
    // A tenancy create ALWAYS carries a Unit-occupancy sync now (mark the unit
    // occupied in step with the new active tenancy), so it must be atomic — the
    // tenancy row and the Unit flip commit together or neither does. When a
    // rent-invoice schedule is also set, its money-adjacent audit row joins the
    // same transaction (Wave-2 review #2).
    const created = await getDb().$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = await (tx as any).tenancy.create({ data: await buildTenancyData(tx), select: { id: true } });
      await markUnitOccupiedForTenancyTx(tx, session.orgId, input.unitId, tenancyData.startDate);
      if (hasInvoiceSchedule) {
        await recordAudit(tx, {
          organizationId: session.orgId,
          actorUserId: session.userId,
          actorRole: session.role,
          action: "tenancy.invoice_schedule_set",
          entityType: "Tenancy",
          entityId: c.id,
          meta: invoiceScheduleAuditMeta(rentInvoiceStartDate, input.firstMonthRentNote),
        });
      }
      return c;
    });
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    // Post-commit, never-throws: see the overwrite branch above.
    await draftCatchupForTenancy(session, created.id);
    await createTenancyDepositsForTenancy(session, created.id);
    return { ok: true as const, status: 201, data: created };
  } catch (e) {
    const mapped = mapTenancyP2002(e);
    if (mapped) return { ok: false as const, ...mapped };
    throw e;
  }
}

export async function updateTenancyService(session: TenancySession, input: z.infer<typeof updateTenancySchema>) {
  const existing = await findTenancy(session.orgId, input.tenancyId);
  if (!existing) return { ok: false as const, status: 404, error: "Tenancy not found" };

  const updateChangesCommission =
    (input.firstMonthIsCommission !== undefined && input.firstMonthIsCommission !== existing.firstMonthIsCommission) ||
    (input.commissionSstBearer !== undefined && input.commissionSstBearer !== existing.commissionSstBearer);
  const updateGuard = await assertCommissionWritable(session, updateChangesCommission, input.tenancyId);
  if (!updateGuard.ok) return { ok: false as const, status: updateGuard.status, error: updateGuard.error, code: updateGuard.code };

  // Wave-2 #2: the update payload carries no startDate, so the schema refiner
  // cannot enforce invoice-start >= move-in. Re-check here against the STORED
  // Tenancy.startDate before writing, or a rent invoice could be scheduled for
  // pre-move-in months (money path). Compared as UTC calendar days: both the
  // incoming value and the stored move-in are normalised to UTC midnight, so
  // the compare never drifts on the UTC+8 server.
  const invoiceStartDate = rentInvoiceStartToUtcDate(input.rentInvoiceStartDate);
  if (invoiceStartDate && existing.startDate) {
    const s = existing.startDate;
    const moveInUtc = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
    if (invoiceStartDate.getTime() < moveInUtc) {
      return { ok: false as const, status: 400, error: "Rental invoicing cannot start before the move-in date" };
    }
  }

  const data = {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.billingStatus !== undefined ? { billingStatus: input.billingStatus } : {}),
    ...(input.endDate !== undefined ? { endDate: input.endDate ? new Date(input.endDate) : null } : {}),
    ...(input.monthlyRentAmount !== undefined ? { monthlyRentAmount: Number(input.monthlyRentAmount) } : {}),
    ...(input.depositAmount !== undefined ? { depositAmount: input.depositAmount === "" ? null : Number(input.depositAmount) } : {}),
    // Wave-2 #1/#3: persist the rent-invoice fields. `undefined` = key omitted
    // (leave untouched); an explicit `null` clears the schedule; a valid date is
    // stored as UTC midnight of the calendar day (rentInvoiceStartToUtcDate).
    ...(input.rentInvoiceStartDate !== undefined ? { rentInvoiceStartDate: invoiceStartDate } : {}),
    ...(input.firstMonthRentNote !== undefined ? { firstMonthRentNote: input.firstMonthRentNote } : {}),
    ...(input.firstMonthIsCommission !== undefined ? { firstMonthIsCommission: input.firstMonthIsCommission } : {}),
    ...(input.commissionSstBearer !== undefined ? { commissionSstBearer: input.commissionSstBearer } : {}),
  };

  // Terminal status → release this tenancy's carpark bays in the SAME transaction,
  // so a bay never stays "rented" against an ended tenancy.
  const TERMINAL_TENANCY_STATUSES = new Set(["ended", "terminated", "expired"]);
  const isTerminal = input.status !== undefined && TERMINAL_TENANCY_STATUSES.has(input.status);
  // Wave-2 review #2: setting/moving/clearing the invoice schedule on an existing
  // tenancy changes WHEN rent invoices fire -- money-adjacent, so it must leave an
  // in-transaction audit trail. Emitted only when a schedule field is present in
  // the payload, so ordinary tenancy edits keep their existing (lighter) shape.
  const invoiceScheduleTouched =
    input.rentInvoiceStartDate !== undefined || input.firstMonthRentNote !== undefined;

  if (isTerminal || invoiceScheduleTouched) {
    const endDate = input.endDate ? new Date(input.endDate) : new Date();
    await getDb().$transaction(async (tx) => {
      await tx.tenancy.update({ where: { id: input.tenancyId }, data });
      if (isTerminal) {
        await releaseAssignmentsForTenancyTx(tx, session.orgId, input.tenancyId, endDate);
      }
      if (invoiceScheduleTouched) {
        const meta: Record<string, string | null> = {};
        if (input.rentInvoiceStartDate !== undefined) {
          meta.rentInvoiceStartDate = invoiceStartDate ? invoiceStartDate.toISOString() : null;
        }
        if (input.firstMonthRentNote !== undefined) {
          meta.firstMonthRentNote = input.firstMonthRentNote ?? null;
        }
        await recordAudit(tx, {
          organizationId: session.orgId,
          actorUserId: session.userId,
          actorRole: session.role,
          action: "tenancy.invoice_schedule_updated",
          entityType: "Tenancy",
          entityId: input.tenancyId,
          meta,
        });
      }
    });
  } else {
    await updateTenancy(input.tenancyId, data);
  }

  dashboardCache.invalidate(`dashboard:${session.orgId}`);

  // Post-commit, never-throws (same contract as the creators above). Editing a
  // move-out date, the rent, or the status changes what this month's rent SHOULD
  // be — and until now nothing acted on that. Setting Tenant X's move-out to the
  // 15th left X's already-drafted FULL month standing, so when Tenant Y was
  // assigned on the 16th and correctly drafted 16/31 days, the unit-month billed
  // more than the unit's own monthly rent. The catch-up re-prorates the unit's
  // unapproved drafts (and drafts a now-billable current month that had none).
  // Gated to the billing-relevant fields so an ordinary edit — a deposit, a note
  // — does not reach into billing at all.
  // `firstMonthIsCommission` belongs here even though it moves no amount: it
  // decides the drafted charge TYPE (monthlyChargeType → letting_commission vs
  // rent), which routes the money to KAEN revenue instead of owner rent.
  const billingFactsChanged =
    input.endDate !== undefined ||
    input.monthlyRentAmount !== undefined ||
    input.status !== undefined ||
    input.firstMonthIsCommission !== undefined;
  if (billingFactsChanged) {
    await draftCatchupForTenancy(session, input.tenancyId);
  }

  return { ok: true as const, status: 200, data: { id: input.tenancyId } };
}

export async function renewTenancyService(session: TenancySession, input: z.infer<typeof renewTenancySchema>) {
  const existing = await findTenancy(session.orgId, input.tenancyId);
  if (!existing) return { ok: false as const, status: 404, error: "Tenancy not found" };

  const duplicateCode = await findTenancyByCode(session.orgId, input.newTenancyCode);
  if (duplicateCode) return { ok: false as const, status: 409, error: "New tenancy code already exists" };

  const monthlyRent = Number(input.monthlyRentAmount);
  if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
    return { ok: false as const, status: 400, error: "Monthly rent must be a valid positive amount" };
  }

  const created = await renewTenancyTx({
    existingTenancyId: existing.id,
    newStartDate: new Date(input.newStartDate),
    organizationId: session.orgId,
    propertyId: existing.propertyId,
    unitId: existing.unitId,
    tenantPartyId: existing.tenantPartyId,
    newTenancyCode: input.newTenancyCode,
    newEndDate: input.newEndDate ? new Date(input.newEndDate) : null,
    monthlyRentAmount: monthlyRent,
  });

  dashboardCache.invalidate(`dashboard:${session.orgId}`);
  // Post-commit, never-throws: a renewal signed after the advance run already
  // drafted its first month (e.g. renewed on the 26th for next month) would
  // otherwise miss that month's rent draft.
  await draftCatchupForTenancy(session, created.id);
  return { ok: true as const, status: 201, data: created };
}
