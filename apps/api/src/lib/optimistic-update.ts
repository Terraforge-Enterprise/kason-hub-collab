// apps/api/src/lib/optimistic-update.ts
import { Prisma } from "@kason/db";

/**
 * updatedAt-in-WHERE optimistic concurrency for Charge/Payment/Invoice writes
 * (Phase-2 finance modules M3/M4/M5/M6). Wrap an update whose WHERE includes
 * `updatedAt: new Date(expectedUpdatedAt)`:
 *
 *   const res = await withStaleCheck(() =>
 *     tx.charge.update({
 *       where: { id, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
 *       data,
 *       select: { updatedAt: true },
 *     }),
 *   );
 *   if (res === null) return { ok: false, status: 409, error: "Record changed since you loaded it" };
 *
 * Prisma raises P2025 when zero rows match — mapped to null here; the route
 * returns 409. Mirrors the existing pattern in parties.repository.ts.
 */
export async function withStaleCheck<T>(update: () => Promise<T>): Promise<T | null> {
  try {
    return await update();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return null;
    }
    throw err;
  }
}
