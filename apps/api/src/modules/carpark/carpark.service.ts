import { getDb, Prisma } from "@kason/db";
import type { CreateCarparkInput, UpdateCarparkInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import type { AdminSession } from "./carpark.types";
import {
  findApartmentForCarpark,
  findCarparkById,
  listCarparksByApartment,
  listAvailableCarparksByProperty,
  countActiveAssignments,
} from "./carpark.repository";

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

export type CarparkRow = {
  id: string;
  label: string;
  monthlyRate: string;
  status: string;
  apartmentId: string;
  propertyId: string;
  ownerPartyId: string | null;
  ownerName: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(row: any): CarparkRow {
  return {
    id: row.id,
    label: row.label,
    monthlyRate: row.monthlyRate.toString(),
    status: row.status,
    apartmentId: row.apartmentId,
    propertyId: row.propertyId,
    ownerPartyId: row.ownerPartyId ?? null,
    ownerName: row.ownerParty?.displayName ?? null,
  };
}

/**
 * Register a new carpark bay. Derives propertyId and ownerPartyId from the
 * home apartment (resolves ownerPartyId from a sibling Listing on the apartment).
 */
export async function registerCarparkService(
  session: AdminSession,
  input: CreateCarparkInput,
): Promise<Result<{ id: string }>> {
  const { orgId, userId } = session;
  const { apartmentId, label, monthlyRate, notes } = input;

  const apt = await findApartmentForCarpark(orgId, apartmentId);
  if (!apt) return err(404, "Apartment not found");

  const propertyId = apt.propertyId;
  const ownerPartyId = apt.listings[0]?.ownerPartyId ?? null;

  return getDb().$transaction(async (tx) => {
    const carpark = await tx.carpark.create({
      data: {
        organizationId: orgId,
        propertyId,
        apartmentId,
        ownerPartyId,
        label,
        monthlyRate,
        notes,
        status: "available",
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      organizationId: orgId,
      actorUserId: userId,
      actorRole: "admin",
      action: "carpark.register",
      entityType: "Carpark",
      entityId: carpark.id,
      diff: { label, monthlyRate, apartmentId, propertyId } as unknown as Prisma.InputJsonValue,
    });

    return ok({ id: carpark.id }, 201);
  });
}

export async function listCarparksByApartmentService(
  session: AdminSession,
  apartmentId: string,
): Promise<Result<CarparkRow[]>> {
  const rows = await listCarparksByApartment(session.orgId, apartmentId);
  return ok(rows.map(toRow));
}

export async function listAvailableCarparksByPropertyService(
  session: AdminSession,
  propertyId: string,
): Promise<Result<CarparkRow[]>> {
  const rows = await listAvailableCarparksByProperty(session.orgId, propertyId);
  return ok(rows.map(toRow));
}

/**
 * Update a carpark bay's label, monthly rate, status, or notes.
 * Whitelisted fields only — no identity or owner changes here.
 */
export async function updateCarparkService(
  session: AdminSession,
  input: UpdateCarparkInput,
): Promise<Result<{ id: string }>> {
  const { orgId, userId } = session;
  const { carparkId, label, monthlyRate, status, notes } = input;

  const existing = await findCarparkById(orgId, carparkId);
  if (!existing) return err(404, "Carpark not found");

  // Guard: updating status to "inactive" must respect the same active-assignment
  // check that deactivateCarparkService uses — a PATCH cannot bypass the 409
  // by setting the status field directly.
  if (status === "inactive") {
    const activeCount = await countActiveAssignments(orgId, carparkId);
    if (activeCount > 0) return err(409, "Carpark has an active rental");
  }

  const data: Record<string, unknown> = {};
  if (label !== undefined) data.label = label;
  if (monthlyRate !== undefined) data.monthlyRate = monthlyRate;
  if (status !== undefined) data.status = status;
  if (notes !== undefined) data.notes = notes;

  return getDb().$transaction(async (tx) => {
    const updated = await tx.carpark.update({
      where: { id: carparkId },
      data,
      select: { id: true },
    });

    await recordAudit(tx, {
      organizationId: orgId,
      actorUserId: userId,
      actorRole: "admin",
      action: "carpark.update",
      entityType: "Carpark",
      entityId: carparkId,
      diff: data as unknown as Prisma.InputJsonValue,
    });

    return ok({ id: updated.id });
  });
}

/**
 * Deactivate a carpark bay. Blocked (409) if any active assignment exists —
 * caller must end the assignment first.
 */
export async function deactivateCarparkService(
  session: AdminSession,
  carparkId: string,
): Promise<Result<{ id: string }>> {
  const { orgId, userId } = session;

  const existing = await findCarparkById(orgId, carparkId);
  if (!existing) return err(404, "Carpark not found");

  const activeCount = await countActiveAssignments(orgId, carparkId);
  if (activeCount > 0) return err(409, "Carpark has an active rental");

  return getDb().$transaction(async (tx) => {
    const updated = await tx.carpark.update({
      where: { id: carparkId },
      data: { status: "inactive" },
      select: { id: true },
    });

    await recordAudit(tx, {
      organizationId: orgId,
      actorUserId: userId,
      actorRole: "admin",
      action: "carpark.deactivate",
      entityType: "Carpark",
      entityId: carparkId,
      diff: { status: "inactive" } as unknown as Prisma.InputJsonValue,
    });

    return ok({ id: updated.id });
  });
}
