import { getDb } from "@kason/db";

type Session = {
  orgId: string;
  userId: string;
  role: string;
  userType?: string;
};

type ServiceResult<T> =
  | { ok: true; status: 200 | 201; data: T }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

type CreateInput = {
  tier: number;
  rentalMin: string;
  rentalMax?: string | null;
  companyMinimum: string;
};
type UpdateInput = {
  rentalMin?: string;
  rentalMax?: string | null;
  companyMinimum?: string;
  updatedAt: string;
};

/**
 * Create a new TaTier row for the caller's organisation.
 *
 * Rejects with 409 if a tier with the same number already exists — callers
 * should edit the existing row instead. Writes a single ActivityLog entry
 * in the same transaction as the insert.
 */
export async function createTaTierService(
  session: Session,
  input: CreateInput,
): Promise<ServiceResult<{ id: string; tier: number }>> {
  const db = getDb();
  const duplicate = await db.taTier.findFirst({
    where: { organizationId: session.orgId, tier: input.tier },
    select: { id: true },
  });
  if (duplicate) {
    return {
      ok: false,
      status: 409,
      error: `TA tier ${input.tier} already exists. Edit the existing row instead.`,
    };
  }

  return db.$transaction(async (tx) => {
    const created = await tx.taTier.create({
      data: {
        organizationId: session.orgId,
        tier: input.tier,
        rentalMin: input.rentalMin,
        // `rentalMax` is optional: admins may leave it null for the top
        // (open-ended) tier. Explicit undefined skips the column on insert
        // so the DB default (NULL) is used.
        ...(input.rentalMax !== undefined ? { rentalMax: input.rentalMax } : {}),
        companyMinimum: input.companyMinimum,
      },
      select: { id: true, tier: true },
    });
    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "ta_tier",
        entityId: created.id,
        action: "created",
        description: `TA tier ${created.tier} created`,
        performedBy: session.userId,
        metadata: input,
      },
    });
    return { ok: true as const, status: 201 as const, data: created };
  });
}

/**
 * Update rentalMin / companyMinimum on an existing TaTier row.
 *
 * Uses optimistic concurrency on `updatedAt` — if another admin modified
 * the row since the client loaded it, we return 409 so the UI can reload.
 * Writes an ActivityLog entry with the incoming patch payload.
 */
export async function updateTaTierService(
  session: Session,
  id: string,
  input: UpdateInput,
): Promise<ServiceResult<{ id: string; updatedAt: Date }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const update = await tx.taTier.updateMany({
      where: {
        id,
        organizationId: session.orgId,
        updatedAt: new Date(input.updatedAt),
      },
      data: {
        ...(input.rentalMin !== undefined ? { rentalMin: input.rentalMin } : {}),
        // Null-safe: explicit null clears the upper bound (open-ended tier);
        // undefined leaves the column untouched.
        ...(input.rentalMax !== undefined ? { rentalMax: input.rentalMax } : {}),
        ...(input.companyMinimum !== undefined ? { companyMinimum: input.companyMinimum } : {}),
      },
    });
    if (update.count === 0) {
      return {
        ok: false as const,
        status: 409 as const,
        error: "TA tier was modified by another admin. Please reload.",
      };
    }
    const fresh = await tx.taTier.findFirst({
      where: { id, organizationId: session.orgId },
      select: { id: true, updatedAt: true, tier: true },
    });
    if (!fresh) {
      return { ok: false as const, status: 404 as const, error: "TA tier not found" };
    }
    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "ta_tier",
        entityId: id,
        action: "updated",
        description: `TA tier ${fresh.tier} updated`,
        performedBy: session.userId,
        metadata: input,
      },
    });
    return {
      ok: true as const,
      status: 200 as const,
      data: { id: fresh.id, updatedAt: fresh.updatedAt },
    };
  });
}

/**
 * Delete a TaTier row.
 *
 * No soft-delete — these rows are admin config and the taTier lookup
 * service treats a missing tier as an opportunity to fall through to the
 * next bracket. Writes an ActivityLog entry in the same transaction.
 */
export async function deleteTaTierService(
  session: Session,
  id: string,
): Promise<ServiceResult<{ id: string }>> {
  const db = getDb();
  const existing = await db.taTier.findFirst({
    where: { id, organizationId: session.orgId },
    select: { id: true, tier: true },
  });
  if (!existing) return { ok: false, status: 404, error: "TA tier not found" };
  return db.$transaction(async (tx) => {
    await tx.taTier.delete({ where: { id } });
    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "ta_tier",
        entityId: id,
        action: "deleted",
        description: `TA tier ${existing.tier} deleted`,
        performedBy: session.userId,
      },
    });
    return { ok: true as const, status: 200 as const, data: { id } };
  });
}
