import type { PrismaClient } from "@prisma/client";

/**
 * One audited (model, column) scan. `count` is the number of non-null/non-empty
 * storage keys this column contributed to the referenced-key set — the manifest
 * is how reconciliation completeness is audited, so EVERY scanned column must
 * appear here even when it contributes zero keys.
 */
export interface ScanManifestEntry {
  model: string;
  column: string;
  count: number;
}

export interface ScanReferencesResult {
  keys: Set<string>;
  manifest: ScanManifestEntry[];
}

/** A scalar-string storage-key column (one key per row). */
interface ScalarSpec {
  model: string;
  column: string;
  /** Prisma delegate name on the client (e.g. "user", "documentTemplate"). */
  delegate: string;
  kind: "scalar";
  /** Optional extra WHERE narrowing (e.g. PendingUpload status filter). */
  where?: Record<string, unknown>;
}

/** A String[] storage-key column (zero-or-more keys per row). */
interface ArraySpec {
  model: string;
  column: string;
  delegate: string;
  kind: "array";
  where?: Record<string, unknown>;
}

type ColumnSpec = ScalarSpec | ArraySpec;

/**
 * The authoritative list of every column in the Prisma schema that stores a
 * Supabase Storage object key. Verified against
 * packages/db/prisma/schema.prisma (line refs in comments). Deliberately does
 * NOT include UnitAttribute.attributeKey — that is a key-value attribute NAME,
 * not a storage object key.
 *
 * If you add a new storage-key column to the schema, add it here too, or the
 * reconciliation report will mis-flag its objects as orphans.
 */
const COLUMN_SPECS: ColumnSpec[] = [
  { model: "User", column: "photoKey", delegate: "user", kind: "scalar" }, // ~148
  { model: "Listing", column: "photoKeys", delegate: "listing", kind: "array" }, // ~385
  { model: "Listing", column: "coverPhotoKey", delegate: "listing", kind: "scalar" }, // ~386
  { model: "Listing", column: "videoKeys", delegate: "listing", kind: "array" }, // ~387
  { model: "Party", column: "photoKey", delegate: "party", kind: "scalar" }, // ~498
  { model: "Charge", column: "attachmentKeys", delegate: "charge", kind: "array" }, // ~710
  { model: "Payment", column: "attachmentKeys", delegate: "payment", kind: "array" }, // ~829
  { model: "MaintenanceRequest", column: "photoKeys", delegate: "maintenanceRequest", kind: "array" }, // ~1029
  { model: "Document", column: "storageKey", delegate: "document", kind: "scalar" }, // ~1050
  { model: "CommissionClaimItem", column: "tenantIcFrontKey", delegate: "commissionClaimItem", kind: "scalar" }, // ~1170
  { model: "CommissionClaimItem", column: "tenantIcBackKey", delegate: "commissionClaimItem", kind: "scalar" }, // ~1171
  // PendingUpload: only rows still "live" — exclude already-deleted and expired
  // rows so their (intentionally orphaned) keys are not treated as referenced.
  {
    model: "PendingUpload",
    column: "storageKey",
    delegate: "pendingUpload",
    kind: "scalar",
    where: { status: { notIn: ["deleted", "expired"] } },
  }, // ~1353
  { model: "RenovationClaimDocument", column: "fileKey", delegate: "renovationClaimDocument", kind: "scalar" }, // ~1670
  { model: "OrganizationCardSettings", column: "logoKey", delegate: "organizationCardSettings", kind: "scalar" }, // ~1814
  { model: "DocumentTemplate", column: "logoKey", delegate: "documentTemplate", kind: "scalar" }, // ~1841
  { model: "UnitReservation", column: "signatureDrawingKey", delegate: "unitReservation", kind: "scalar" }, // ~1931
  { model: "UnitReservation", column: "signedPdfKey", delegate: "unitReservation", kind: "scalar" }, // ~1935
  { model: "Invoice", column: "pdfKey", delegate: "invoice", kind: "scalar" }, // ~2003
  { model: "Invoice", column: "attachmentKeys", delegate: "invoice", kind: "array" }, // ~2005
  { model: "MeterReading", column: "imageKey", delegate: "meterReading", kind: "scalar" }, // ~2057
  { model: "Task", column: "attachmentKeys", delegate: "task", kind: "array" }, // ~2105
  { model: "Ticket", column: "attachmentKeys", delegate: "ticket", kind: "array" }, // ~2133
  { model: "TicketHistory", column: "attachmentKeys", delegate: "ticketHistory", kind: "array" }, // ~2153
  { model: "ImportRun", column: "reportKey", delegate: "importRun", kind: "scalar" }, // ~2234
];

/** Number of distinct storage-key columns this scanner covers. */
export const SCANNED_COLUMN_COUNT = COLUMN_SPECS.length;

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Collect EVERY non-null/non-empty Supabase Storage object key across the whole
 * schema into a single Set, and record a per-column manifest of how many keys
 * each column contributed (the completeness audit trail). Pure read — issues
 * only `findMany` selects, never writes.
 */
export async function scanReferencedKeys(
  prisma: PrismaClient,
): Promise<ScanReferencesResult> {
  const keys = new Set<string>();
  const manifest: ScanManifestEntry[] = [];

  for (const spec of COLUMN_SPECS) {
    // Each delegate is addressed dynamically by name; cast through unknown
    // because the union of all delegates has no single static shape.
    const delegate = (prisma as unknown as Record<string, {
      findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    }>)[spec.delegate];

    const rows = await delegate.findMany({
      where: spec.where,
      select: { [spec.column]: true },
    });

    let count = 0;
    for (const row of rows) {
      const value = row[spec.column];
      if (spec.kind === "array") {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isNonEmpty(item)) {
              keys.add(item);
              count++;
            }
          }
        }
      } else if (isNonEmpty(value)) {
        keys.add(value);
        count++;
      }
    }

    manifest.push({ model: spec.model, column: spec.column, count });
  }

  return { keys, manifest };
}
