import { getDb, Prisma } from "@kason/db";
import type { AssignCarparkInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import type { AdminSession } from "./carpark.types";
import {
  findTenancyForCarparkAssignment,
  findCarparkAssignmentById,
} from "./carpark.repository";

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

/**
 * Tx-bound helper. Assigns one or more carpark bays inside an existing Prisma
 * transaction. Used both by assignCarparksToTenancyService (standalone assign)
 * and createTenancyService (atomic tenancy-create + carpark-attach).
 *
 * Guards (all inside the passed tx):
 *  - Bay must belong to the same property as `propertyId` → 422 CARPARK_WRONG_BUILDING.
 *  - Bay must be status:"available" → 409 CARPARK_ALREADY_RENTED.
 *  - Concurrent-race P2002 on create → 409 CARPARK_ALREADY_RENTED.
 *
 * On success: each bay's status is flipped to "rented" and a CarparkAssignment
 * record is created (status:"active").
 */
export async function assignCarparksTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  session: AdminSession,
  tenancyId: string,
  propertyId: string,
  carparks: Array<{ carparkId: string; monthlyCharge?: string }>,
): Promise<Result<{ assignmentIds: string[] }>> {
  const { orgId, userId } = session;
  const today = new Date();
  const assignmentIds: string[] = [];

  for (const { carparkId, monthlyCharge } of carparks) {
    // Read bay inside the tx: validates building match, availability, and resolves
    // the default monthly charge — all in one round-trip.
    const bay = await tx.carpark.findFirst({
      where: { id: carparkId, organizationId: orgId },
      select: { propertyId: true, status: true, monthlyRate: true },
    });
    if (!bay) return err(404, `Carpark ${carparkId} not found`);
    if (bay.propertyId !== propertyId) return err(422, "CARPARK_WRONG_BUILDING");
    if (bay.status !== "available") return err(409, "CARPARK_ALREADY_RENTED");

    const resolvedCharge: string = monthlyCharge ?? bay.monthlyRate.toString();

    let assignment: { id: string };
    try {
      assignment = await tx.carparkAssignment.create({
        data: {
          organizationId: orgId,
          carparkId,
          tenancyId,
          monthlyCharge: resolvedCharge,
          startDate: today,
          status: "active",
        },
        select: { id: true },
      });
    } catch (createErr) {
      // The DB partial unique index fires as P2002 when two concurrent requests
      // race through both the pre-check and the in-tx re-read. Map it to the
      // same 409 the caller expects.
      if (
        createErr instanceof Prisma.PrismaClientKnownRequestError &&
        createErr.code === "P2002"
      ) {
        return err(409, "CARPARK_ALREADY_RENTED");
      }
      throw createErr;
    }

    await tx.carpark.update({
      where: { id: carparkId },
      data: { status: "rented" },
    });

    await recordAudit(tx, {
      organizationId: orgId,
      actorUserId: userId,
      actorRole: "admin",
      action: "carpark.assign",
      entityType: "CarparkAssignment",
      entityId: assignment.id,
      diff: { carparkId, tenancyId, monthlyCharge: resolvedCharge } as unknown as Prisma.InputJsonValue,
    });

    assignmentIds.push(assignment.id);
  }

  return ok({ assignmentIds }, 201);
}

/**
 * Assign one or more carpark bays to an existing tenancy.
 *
 * Thin wrapper: loads the tenancy, opens a transaction, and delegates all
 * per-bay validation and writes to assignCarparksTx. External behavior and
 * error codes are unchanged.
 */
export async function assignCarparksToTenancyService(
  session: AdminSession,
  input: AssignCarparkInput,
): Promise<Result<{ assignmentIds: string[] }>> {
  const { orgId } = session;
  const { tenancyId, carparks } = input;

  const tenancy = await findTenancyForCarparkAssignment(orgId, tenancyId);
  if (!tenancy) return err(404, "Tenancy not found");

  // Atomic: all bays succeed or none are committed. If assignCarparksTx returns
  // ok:false for any bay (e.g. the 2nd bay is already rented), we throw a tagged
  // error inside the transaction to force a full rollback — earlier bays in the
  // same batch are NOT left in the "rented" state. The tag is caught below and
  // unwrapped to the original {ok:false,status,error} shape.
  let txResult: Result<{ assignmentIds: string[] }>;
  try {
    txResult = await getDb().$transaction(async (tx) => {
      const result = await assignCarparksTx(tx, session, tenancyId, tenancy.propertyId, carparks);
      if (!result.ok) {
        throw Object.assign(new Error(result.error), { _carparkStatus: result.status });
      }
      return result;
    });
  } catch (e) {
    const ce = e as { _carparkStatus?: number; message?: string };
    if (typeof ce._carparkStatus === "number") {
      return err(ce._carparkStatus, ce.message ?? "Carpark assignment failed");
    }
    throw e;
  }
  return txResult;
}

/**
 * Tx-bound. Reused by Task 3.3 (tenancy-end hooks) to auto-release all
 * carpark assignments when a tenancy ends.
 *
 * Sets each active assignment status:"ended" + endDate, and flips its bay
 * back to status:"available". No audit writes — callers audit at the tenancy
 * level.
 */
export async function releaseAssignmentsForTenancyTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  tenancyId: string,
  endDate: Date,
): Promise<void> {
  const active = await tx.carparkAssignment.findMany({
    where: { organizationId: orgId, tenancyId, status: "active" },
    select: { id: true, carparkId: true },
  });

  for (const { id, carparkId } of active) {
    await tx.carparkAssignment.update({
      where: { id },
      data: { status: "ended", endDate },
    });

    await tx.carpark.update({
      where: { id: carparkId },
      data: { status: "available" },
    });
  }
}

/**
 * Release a single carpark assignment (admin-initiated mid-tenancy release).
 * Ends the assignment and returns the bay to "available".
 *
 * For bulk tenancy-end, use `releaseAssignmentsForTenancyTx` instead.
 */
export async function releaseAssignmentService(
  session: AdminSession,
  assignmentId: string,
): Promise<Result<{ id: string }>> {
  const { orgId, userId } = session;

  const existing = await findCarparkAssignmentById(orgId, assignmentId);
  if (!existing) return err(404, "Assignment not found or already ended");

  return getDb().$transaction(async (tx) => {
    await tx.carparkAssignment.update({
      where: { id: assignmentId },
      data: { status: "ended", endDate: new Date() },
    });

    await tx.carpark.update({
      where: { id: existing.carparkId },
      data: { status: "available" },
    });

    await recordAudit(tx, {
      organizationId: orgId,
      actorUserId: userId,
      actorRole: "admin",
      action: "carpark.release",
      entityType: "CarparkAssignment",
      entityId: assignmentId,
      diff: { status: "ended" } as unknown as Prisma.InputJsonValue,
    });

    return ok({ id: assignmentId });
  });
}
