import { getDb } from "@kason/db";
import { generateTenancyCodeTx } from "./tenancy-code-generator";
import { recordAudit } from "../../lib/audit";
import { assertNoActiveTenancyTx } from "./active-tenancy-guard";
import { mapTenancyP2002 } from "./tenancy-p2002";
import {
  assignCarparksTx,
  releaseAssignmentsForTenancyTx,
} from "../carpark/carpark-assignment.service";
import { draftCatchupForTenancy } from "../billing/draft-catchup.hook";
import { createTenancyDepositsForTenancy } from "../billing/tenancy-deposits";

export type ConvertSession = { orgId: string; userId: string; role: string };
export type ConvertInput = {
  reservationId: string;
  tenantPartyId: string;
  overwrite?: boolean;
  tenancyCode?: string;
  carparks?: Array<{ carparkId: string; monthlyCharge?: string }>;
};

// Explicit named union (not inferred) -- without it, the two branches'
// differing optional fields (.incumbent / .existingTenancyId / .code) make
// the inferred return type heterogeneous and callers that touch those
// fields fail tsc silently (esbuild/vitest won't catch it).
export type ConvertResult =
  | {
      ok: true;
      status: 201;
      data: { id: string; supersededTenancyId?: string };
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      incumbent?: { tenantName: string; endDate: Date | null };
      existingTenancyId?: string;
    };

// Task 5 scope: guards + derivation only. Guard order is significant (see
// each branch below); overlap warn/overwrite + carpark assign + P2002
// mapping is Task 6 -- until then, any active tenancy on the unit blocks
// conversion outright (no incumbent details, no overwrite).
export async function convertReservationToTenancy(
  session: ConvertSession,
  input: ConvertInput,
): Promise<ConvertResult> {
  const db = getDb();
  try {
    const result: ConvertResult = await db.$transaction(async (tx) => {
      const r = await tx.unitReservation.findFirst({
        where: { id: input.reservationId, organizationId: session.orgId },
        select: {
          id: true,
          status: true,
          unitId: true,
          propertyId: true,
          proposedMoveIn: true,
          proposedMoveOut: true,
          agreedMonthlyRent: true,
          tenantPartyId: true,
        },
      });
      if (!r) {
        return {
          ok: false as const,
          status: 404,
          code: "RESERVATION_NOT_FOUND",
          error: "Reservation not found",
        };
      }
      if (r.status !== "signed") {
        return {
          ok: false as const,
          status: 400,
          code: "RESERVATION_NOT_SIGNED",
          error: "Reservation must be signed before it can become a tenancy",
        };
      }
      // Defense-in-depth (T14): a reservation created FROM a specific tenant
      // (tenantPartyId set by parties.service.ts) may only be converted onto
      // that SAME tenant. A direct API caller could otherwise pass a signed
      // reservation's id alongside an unrelated tenantPartyId and have that
      // reservation's dates/rent written onto the wrong tenant's tenancy.
      // Null tenantPartyId (a signed reservation never used to create a
      // tenant -- legacy/direct flows) falls through unchanged.
      if (r.tenantPartyId && r.tenantPartyId !== input.tenantPartyId) {
        return {
          ok: false as const,
          status: 422,
          code: "RESERVATION_TENANT_MISMATCH",
          error: "Reservation is linked to a different tenant",
        };
      }
      if (r.agreedMonthlyRent == null || Number(r.agreedMonthlyRent) <= 0) {
        return {
          ok: false as const,
          status: 400,
          code: "RESERVATION_MISSING_BILLING_DATA",
          error: "Reservation has no valid agreed monthly rent",
        };
      }

      const existing = await tx.tenancy.findFirst({
        where: { organizationId: session.orgId, reservationId: r.id },
        select: { id: true },
      });
      if (existing) {
        return {
          ok: false as const,
          status: 409,
          code: "RESERVATION_ALREADY_CONVERTED",
          error: "Reservation already converted",
          existingTenancyId: existing.id,
        };
      }

      // Tenant identity by ROLE (matches searchTenants / findTenantRole), never
      // partyType -- a party may hold a tenant role while its partyType is
      // something else, and must still be accepted.
      const tenantRole = await tx.partyRole.findFirst({
        where: {
          organizationId: session.orgId,
          partyId: input.tenantPartyId,
          roleType: "tenant",
        },
        select: { id: true },
      });
      if (!tenantRole) {
        return {
          ok: false as const,
          status: 400,
          code: "TENANT_PARTY_INVALID",
          error: "Selected tenant is not valid for this organization",
        };
      }

      // Owner guard -- money attribution requires an owner (parity with
      // createTenancyService + occupancy-tenancy-sync). Tenancy.unit targets Listing.
      const unit = await tx.listing.findFirst({
        where: { id: r.unitId, organizationId: session.orgId },
        select: { ownerPartyId: true },
      });
      if (!unit?.ownerPartyId) {
        return {
          ok: false as const,
          status: 409,
          code: "UNIT_HAS_NO_OWNER",
          error:
            "This unit has no assigned owner. Assign an owner before creating a tenancy.",
        };
      }

      // Unit-free guard: warn-with-incumbent-details when overwrite isn't
      // requested; overwrite closes the incumbent (+ releases its carpark
      // bays) in the SAME tx so the supersession is atomic with the new
      // tenancy's create below.
      const active = await assertNoActiveTenancyTx(tx, session.orgId, r.unitId);
      let supersededTenancyId: string | undefined;
      if (active) {
        if (!input.overwrite) {
          const inc = await tx.tenancy.findFirst({
            where: { id: active.id },
            select: {
              endDate: true,
              tenantParty: { select: { displayName: true } },
            },
          });
          return {
            ok: false as const,
            status: 409,
            code: "UNIT_HAS_ACTIVE_TENANCY",
            error: "Unit already has an active tenancy",
            incumbent: {
              tenantName: inc?.tenantParty?.displayName ?? "current tenant",
              endDate: inc?.endDate ?? null,
            },
          };
        }
        // A superseded tenancy can't end before it began: clamp to its own
        // start when the incoming move-in predates it (backdated/erroneous
        // reservation). Reuse the same clamped date for the carpark release
        // below so a released bay assignment is never dated before the
        // tenancy it belongs to even started.
        const supersededEndDate =
          r.proposedMoveIn >= active.startDate
            ? r.proposedMoveIn
            : active.startDate;
        await tx.tenancy.update({
          where: { id: active.id },
          data: { status: "ended", endDate: supersededEndDate },
        });
        await releaseAssignmentsForTenancyTx(
          tx,
          session.orgId,
          active.id,
          supersededEndDate,
        );
        supersededTenancyId = active.id;
      }

      const tenancyCode =
        input.tenancyCode ?? (await generateTenancyCodeTx(tx, session.orgId));
      // From here on we only ever THROW on failure, never `return` -- a
      // `return` after a write commits the transaction as-is, which would
      // leave a superseded-but-orphaned incumbent if the carpark assign below
      // fails. Throwing rolls back the incumbent close-out + this create
      // together (see the outer try/catch for the tagged-error unwrap).
      const created = await tx.tenancy.create({
        data: {
          organizationId: session.orgId,
          propertyId: r.propertyId,
          unitId: r.unitId,
          tenantPartyId: input.tenantPartyId,
          tenancyCode,
          status: "active",
          billingStatus: "active",
          startDate: r.proposedMoveIn,
          endDate: r.proposedMoveOut,
          monthlyRentAmount: r.agreedMonthlyRent,
          reservationId: r.id,
          previousTenancyId: supersededTenancyId,
        },
        select: { id: true },
      });
      if (input.carparks?.length) {
        const res = await assignCarparksTx(
          tx,
          { orgId: session.orgId, userId: session.userId, role: session.role },
          created.id,
          r.propertyId,
          input.carparks,
        );
        if (!res.ok) {
          throw Object.assign(new Error(res.error), {
            _convert: { status: res.status, code: "CARPARK_ASSIGN_FAILED" },
          });
        }
      }
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "tenancy.convert_from_reservation",
        entityType: "Tenancy",
        entityId: created.id,
        meta: { reservationId: r.id, supersededTenancyId },
      });
      return {
        ok: true as const,
        status: 201,
        data: { id: created.id, supersededTenancyId },
      };
    });
    // Post-commit, never-throws: a reservation converted after this period's
    // draft run missed the cohort — draft its rent invoice into the approval
    // queue so the new tenant is billable without waiting for next month's run.
    if (result.ok) await draftCatchupForTenancy(session, result.data.id);
    // Deposits ride their own gated hook (see tenancy-deposits.ts) — never the rent one.
    if (result.ok) await createTenancyDepositsForTenancy(session, result.data.id);
    return result;
  } catch (e) {
    // T9 (R7/R8): extracted into a shared classifier (tenancy-p2002.ts) so
    // createTenancyService reuses the EXACT SAME P2002 discrimination
    // instead of a second, independently-maintained copy. Behavior
    // unchanged -- see that module for the full driverAdapterError.cause
    // rationale.
    const mapped = mapTenancyP2002(e);
    if (mapped) {
      return { ok: false as const, status: mapped.status, code: mapped.code, error: mapped.error };
    }
    // Tagged-error unwrap: the carpark-assign throw inside the tx (above)
    // rolls the whole transaction back; here we turn it back into a
    // structured result instead of letting it propagate as an exception.
    const tagged = (e as { _convert?: { status: number; code: string } })
      ._convert;
    if (tagged) {
      return {
        ok: false as const,
        status: tagged.status,
        code: tagged.code,
        error: (e as Error).message,
      };
    }
    throw e;
  }
}
