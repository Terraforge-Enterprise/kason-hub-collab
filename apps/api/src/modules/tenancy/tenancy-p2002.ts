import { Prisma } from "@kason/db";

/**
 * Shared P2002 (unique constraint violation) classifier for Tenancy writes.
 * Extracted from convertReservationToTenancy (T7) so createTenancyService
 * (T9) reuses the EXACT SAME discrimination instead of a second,
 * independently-maintained copy that could subtly drift.
 *
 * Discriminates three distinct Tenancy unique constraints:
 *   - (organizationId, tenancyCode)                    -> TENANCY_CODE_TAKEN
 *   - reservationId (a concurrent double-use of the SAME
 *     reservation racing past a pre-check)              -> RESERVATION_ALREADY_CONVERTED
 *   - the one-active-per-unit partial index             -> CONCURRENT_ACTIVE_TENANCY (default)
 *
 * meta.target is array-of-columns in modern Prisma OR a string
 * constraint-name in some cases -- normalize to a searchable string. Under
 * THIS project's driver (Prisma 7 + @prisma/adapter-pg, packages/db/src/client.ts),
 * meta.target is UNDEFINED for a real Postgres unique violation; the
 * constraint name/columns instead live under the undocumented
 * meta.driverAdapterError.cause (same discovery already made at
 * billing.service.ts:342-347). Verified empirically against local Postgres
 * for both the tenancyCode unique and the tenancy_one_active_per_unit
 * partial index before writing this -- meta.target alone would silently
 * mislabel every REAL tenancyCode collision as CONCURRENT_ACTIVE_TENANCY.
 * Merge every surface we've observed into one searchable string so this
 * works for the real driver error, the stubbed array/string variants, and
 * any future Prisma version that reintroduces meta.target.
 */
export function isTenancyP2002(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export function classifyTenancyP2002(e: Prisma.PrismaClientKnownRequestError): {
  code: "TENANCY_CODE_TAKEN" | "RESERVATION_ALREADY_CONVERTED" | "CONCURRENT_ACTIVE_TENANCY";
  error: string;
} {
  const raw = e.meta?.target;
  const rawStr = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  const driverCause = (
    e.meta as
      | {
          driverAdapterError?: {
            cause?: {
              originalMessage?: string;
              constraint?: { fields?: string[] };
            };
          };
        }
      | undefined
  )?.driverAdapterError?.cause;
  const driverFields = Array.isArray(driverCause?.constraint?.fields)
    ? driverCause.constraint.fields.join(",")
    : "";
  const driverMessage =
    typeof driverCause?.originalMessage === "string" ? driverCause.originalMessage : "";
  const targetStr = `${rawStr} ${driverFields} ${driverMessage}`;

  if (targetStr.includes("tenancyCode")) {
    return { code: "TENANCY_CODE_TAKEN", error: "Tenancy code already exists." };
  }
  if (targetStr.includes("reservationId")) {
    return {
      code: "RESERVATION_ALREADY_CONVERTED",
      error: "This reservation has already been converted.",
    };
  }
  return {
    code: "CONCURRENT_ACTIVE_TENANCY",
    error: "Another active tenancy was created for this unit — retry.",
  };
}

/**
 * Convenience wrapper for callers that just want a ready-to-return 409
 * result (or null if `e` isn't a Tenancy P2002 at all).
 */
export function mapTenancyP2002(
  e: unknown,
): { status: 409; code: "TENANCY_CODE_TAKEN" | "RESERVATION_ALREADY_CONVERTED" | "CONCURRENT_ACTIVE_TENANCY"; error: string } | null {
  if (!isTenancyP2002(e)) return null;
  const cls = classifyTenancyP2002(e);
  return { status: 409, code: cls.code, error: cls.error };
}
