/**
 * Idempotent data migration: existing Listing.unitKind="carpark" pseudo-rooms
 * → the Carpark + CarparkAssignment model introduced in the carpark-redesign
 * feature branch.
 *
 * Run once per environment (local, staging, client prod) before the UI that
 * reads Carpark rows goes live. Re-running is safe — already-migrated listings
 * are skipped.
 *
 * Usage (localhost only):
 *   DATABASE_URL="<local>" npx tsx scripts/migrate-carpark-listings.ts
 *
 * Data reality: 0 carpark rows on local + staging as of 2026-06-30 so this
 * is effectively a no-op there. It exists for completeness and for any future
 * client-prod run (gated, out of scope for this task).
 *
 * TWO-PHASE DEPLOY NOTE:
 *   This script MUST run on an environment that still has the "unitKind" column
 *   on the "Unit" table (i.e. BEFORE Task 5.5 drops the column). The Prisma
 *   client no longer exposes unitKind after the schema drop, so all reads below
 *   use $queryRaw against the raw "Unit" table. The script validates the column
 *   exists at startup and throws if it has already been dropped.
 */
import "dotenv/config";
import { getDb } from "@kason/db";

export interface MigrationStats {
  processed: number; // carpark listings successfully migrated
  skipped: number;   // already migrated (idempotency guard hit)
  errors: number;    // logged + skipped on error, does NOT abort
}

// Raw-SQL result types (unitKind is read via $queryRaw — not the Prisma client
// — so these compile cleanly even after the column is removed from schema.prisma).
interface OrgRow {
  organizationId: string;
}

interface CarparkListingRow {
  id: string;
  organizationId: string;
  apartmentId: string;
  listingType: string;
  ownerPartyId: string | null;
  baseRentAmount: string | null; // Decimal? comes back as string from raw SQL
  propertyId: string;            // joined from Apartment
}

/**
 * Migrate all Listing.unitKind="carpark" rows across all organisations to the
 * Carpark + CarparkAssignment model.
 *
 * Idempotency key: a Carpark row with the same (organizationId, apartmentId,
 * label) already exists → skip this listing.
 *
 * Exported so integration tests can call it directly.
 */
export async function migrateCarparkListings(): Promise<MigrationStats> {
  const db = getDb();
  const stats: MigrationStats = { processed: 0, skipped: 0, errors: 0 };

  // PRE-DROP SAFETY CHECK: this script is a two-phase deploy tool that must run
  // BEFORE Task 5.5 drops "unitKind". Verify the column still exists; throw if
  // it has already been dropped (nothing left to migrate, and the raw SQL below
  // would be a no-op anyway).
  const colCheck = await db.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'Unit'
        AND column_name = 'unitKind'
    ) AS "exists"
  `;
  if (!colCheck[0]?.exists) {
    throw new Error(
      '[migrate-carpark] ABORT: "unitKind" column does not exist on table "Unit". ' +
      'This script is a PRE-DROP tool and must run BEFORE Task 5.5 drops the column. ' +
      'If the column has already been dropped, all carpark listings have already been migrated.',
    );
  }

  // Find all organisations that still have at least one carpark listing.
  // Uses $queryRaw so this file compiles after unitKind is removed from schema.prisma.
  const orgsWithCarparks = await db.$queryRaw<OrgRow[]>`
    SELECT DISTINCT "organizationId"
    FROM "Unit"
    WHERE "unitKind" = 'carpark'
  `;

  for (const { organizationId } of orgsWithCarparks) {
    // Load all carpark listings for this org in one query.
    // Joins Apartment to surface propertyId without a second round-trip.
    // Uses $queryRaw so this file compiles after unitKind is removed from schema.prisma.
    const carparkListings = await db.$queryRaw<CarparkListingRow[]>`
      SELECT
        u.id,
        u."organizationId",
        u."apartmentId",
        u."listingType",
        u."ownerPartyId",
        u."baseRentAmount",
        a."propertyId"
      FROM "Unit" u
      JOIN "Apartment" a ON a.id = u."apartmentId"
      WHERE u."organizationId" = ${organizationId}::uuid
        AND u."unitKind" = 'carpark'
    `;

    for (const listing of carparkListings) {
      const label = listing.listingType; // "P-01", "P-12", etc.

      try {
        // --- Idempotency guard ---
        const existing = await db.carpark.findFirst({
          where: {
            organizationId,
            apartmentId: listing.apartmentId,
            label,
          },
          select: { id: true },
        });
        if (existing) {
          console.log(
            `[migrate-carpark] SKIP org=${organizationId} apt=${listing.apartmentId} label="${label}" (already migrated → Carpark ${existing.id})`,
          );
          stats.skipped += 1;
          continue;
        }

        const propertyId = listing.propertyId;

        // --- Resolve active carpark tenancy ---
        const activeCarparkTenancy = await db.tenancy.findFirst({
          where: { organizationId, unitId: listing.id, status: "active" },
          select: {
            id: true,
            tenantPartyId: true,
            monthlyRentAmount: true,
            startDate: true,
          },
        });

        // --- Derive monthlyRate and status ---
        const monthlyRate: string =
          activeCarparkTenancy?.monthlyRentAmount?.toString() ??
          listing.baseRentAmount?.toString() ??
          "0.00";

        const carparkStatus = activeCarparkTenancy ? "rented" : "available";

        // --- 1. Create the Carpark row ---
        const newCarpark = await db.carpark.create({
          data: {
            organizationId,
            propertyId,
            apartmentId: listing.apartmentId,
            ownerPartyId: listing.ownerPartyId ?? null,
            label,
            monthlyRate,
            status: carparkStatus,
          },
          select: { id: true },
        });

        console.log(
          `[migrate-carpark] CREATED Carpark ${newCarpark.id} org=${organizationId} apt=${listing.apartmentId} label="${label}" status=${carparkStatus}`,
        );

        // --- 2. Patch carpark rent Charges: carparkId = new bay, unitId = null ---
        const chargeUpdateResult = await db.charge.updateMany({
          where: { organizationId, unitId: listing.id },
          data: { carparkId: newCarpark.id, unitId: null },
        });
        if (chargeUpdateResult.count > 0) {
          console.log(
            `[migrate-carpark]   patched ${chargeUpdateResult.count} charge(s) → carparkId=${newCarpark.id}`,
          );
        }

        // --- 3. Create CarparkAssignment on the renter's ROOM tenancy ---
        if (activeCarparkTenancy) {
          // Find the renter's active NON-carpark tenancy in the same property.
          // The unitKind filter is omitted here: the Prisma schema no longer exposes
          // unitKind after the Task 5.5 column drop. The carpark tenancy itself is
          // already excluded by the id-exclusion below, which is the primary guard.
          // A tenant having two simultaneous carpark tenancies is not a real scenario.
          const roomTenancy = await db.tenancy.findFirst({
            where: {
              organizationId,
              propertyId,
              tenantPartyId: activeCarparkTenancy.tenantPartyId,
              status: "active",
              id: { not: activeCarparkTenancy.id }, // exclude the carpark tenancy itself
            },
            select: { id: true },
          });

          if (!roomTenancy) {
            console.warn(
              `[migrate-carpark] WARN no active room tenancy found for tenantPartyId=${activeCarparkTenancy.tenantPartyId} in property=${propertyId} — CarparkAssignment SKIPPED for Carpark ${newCarpark.id}`,
            );
          } else {
            await db.carparkAssignment.create({
              data: {
                organizationId,
                carparkId: newCarpark.id,
                tenancyId: roomTenancy.id,
                monthlyCharge: monthlyRate,
                startDate: activeCarparkTenancy.startDate,
                status: "active",
              },
            });
            console.log(
              `[migrate-carpark]   created CarparkAssignment carparkId=${newCarpark.id} tenancyId=${roomTenancy.id}`,
            );
          }
        }

        // --- 4. Archive the legacy carpark listing ---
        await db.listing.update({
          where: { id: listing.id },
          data: { listingStatus: "archived" },
        });

        // --- 5. End the carpark tenancy ---
        if (activeCarparkTenancy) {
          await db.tenancy.update({
            where: { id: activeCarparkTenancy.id },
            data: { status: "ended" },
          });
        }

        stats.processed += 1;
      } catch (err) {
        console.error(
          `[migrate-carpark] ERROR org=${organizationId} listing=${listing.id} label="${label}":`,
          err,
        );
        stats.errors += 1;
      }
    }
  }

  return stats;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not point at localhost. Got: ${url.replace(/:[^@]+@/, ":***@")}`,
    );
  }

  console.log("[migrate-carpark] Starting carpark listing migration…");
  const stats = await migrateCarparkListings();
  console.log(
    `[migrate-carpark] Done. processed=${stats.processed} skipped=${stats.skipped} errors=${stats.errors}`,
  );
  if (stats.errors > 0) process.exitCode = 1;
}

// Only auto-run when executed directly (e.g. `tsx scripts/migrate-carpark-listings.ts`),
// NOT when imported by the integration test (which calls migrateCarparkListings() itself —
// importing must not run main(), hit the DATABASE_URL guard, or call $disconnect on a mock).
if (process.argv[1] && /migrate-carpark-listings/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => getDb().$disconnect());
}
