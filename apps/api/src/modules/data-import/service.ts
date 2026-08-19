import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getDb, Prisma } from "@kason/db";
import { createSignedDownloadUrl } from "../../lib/storage";
import { parseWorkbook } from "./parse/sheet";
import { distinctCounts, applyMapping, parseMappingCsv } from "./parse/mapping";
import { planParty, executePartyPlan } from "./match";
import { ensureProperty, ensureRoomListing, ensureCarpark } from "./inventory-resolver";
import { ensureCarparkAssignment } from "./carpark-import";
import { ensureTenancy } from "./tenancy";
import { seedMeterBaseline } from "./meter";
import { buildReportCsv, uploadReport } from "./report";
import {
  createImportRun,
  finishImportRun,
  listImportRuns,
  getImportRun,
} from "./repository";
import type { ImportSession, RawTenantRow, ReportRow } from "./types";

type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };
const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

export interface RunImportOptions {
  dryRun: boolean;
  filePath?: string;
  agentMapCsv?: string;
  roomMapCsv?: string;
  now?: Date;
}

export interface ImportCounts {
  rowsParsed: number;
  partiesCreated: number;
  partiesMatched: number;
  tenanciesCreated: number;
  rowsSkipped: number;
  conflicts: number;
}

const DEFAULT_FILE = "docs/Yannie's Excel/KAEN Tenant Master List.xlsx";

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Resolve a (repo-root-relative) workbook path regardless of cwd: the CLI runs from
 * apps/api under `npm --workspace`, but the source workbook lives at the repo root. */
function resolveWorkbookPath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, filePath);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), filePath); // not found: return cwd-relative for a clear error
}

/** Read + parse the workbook into rows. Extracted so unit tests can mock it. */
export async function readWorkbookRows(filePath: string): Promise<RawTenantRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolveWorkbookPath(filePath));
  return parseWorkbook(wb);
}

export async function runImport(
  session: ImportSession,
  opts: RunImportOptions,
): Promise<Result<{ runId: string; counts: ImportCounts; reportKey: string | null }>> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const filePath = opts.filePath ?? DEFAULT_FILE;
  const agentMap = opts.agentMapCsv ? parseMappingCsv(opts.agentMapCsv) : new Map<string, string>();
  const roomMap = opts.roomMapCsv ? parseMappingCsv(opts.roomMapCsv) : new Map<string, string>();

  let rows: RawTenantRow[];
  try {
    rows = await readWorkbookRows(filePath);
  } catch (e) {
    return err(400, `failed to read workbook ${filePath}: ${(e as Error).message}`);
  }

  // Apply reviewed agent/room mappings (unmapped values pass through unchanged).
  for (const r of rows) {
    r.agentLabel = applyMapping(r.agentLabel, agentMap);
    r.roomName = applyMapping(r.roomName, roomMap);
  }

  const agents = distinctCounts(rows, "agentLabel");
  const roomTypes = distinctCounts(rows, "roomName");

  const run = await createImportRun(session.orgId, opts.dryRun, filePath, session.userId);
  const counts: ImportCounts = {
    rowsParsed: rows.length,
    partiesCreated: 0,
    partiesMatched: 0,
    tenanciesCreated: 0,
    rowsSkipped: 0,
    conflicts: 0,
  };
  const reportRows: ReportRow[] = [];

  for (const row of rows) {
    const rr: ReportRow = {
      sheet: row.sheet,
      row: row.rowNumber,
      unitCode: row.unitCode,
      room: row.roomName,
      tenantMasked: `name#${row.sheet}:${row.rowNumber}`,
      partyAction: "",
      tenancyAction: "",
      carparkAction: null,
      meterAction: null,
      conflict: null,
      notes: null,
    };
    try {
      if (!row.tenantNameRaw || !row.unitCode || !row.roomName) {
        counts.rowsSkipped++;
        rr.partyAction = "skip";
        rr.tenancyAction = "skip";
        rr.conflict = "missing name/unit/room";
        reportRows.push(rr);
        continue;
      }

      if (opts.dryRun) {
        // Dry-run plans only — NO writers. planParty is read-only; the db client
        // satisfies the TransactionClient shape for its read queries.
        const plan = await planParty(db as unknown as Prisma.TransactionClient, session.orgId, row);
        rr.partyAction = plan.action;
        if (plan.action === "create") counts.partiesCreated++;
        else if (plan.action === "match") counts.partiesMatched++;
        rr.tenancyAction = "create";
        counts.tenanciesCreated++;
        if (row.rentalCarpark) {
          rr.carparkAction = "create";
          counts.tenanciesCreated++;
        }
        if (row.latestReading !== null) rr.meterAction = "seed";
        if (plan.action === "match" && Object.keys(plan.diff).length > 0) {
          rr.notes = `diff:${Object.keys(plan.diff).join("|")}`;
        }
      } else {
        // Inventory resolvers each run their OWN transaction — call them OUTSIDE
        // the per-row tx, then do party + tenancy + meter inside ONE tx.
        const propertyId = await ensureProperty(session, row.propertyName);
        const roomListing = await ensureRoomListing(
          session,
          propertyId,
          row.unitCode,
          row.roomName,
          row.rentalRoom,
        );
        let carparkBayId: string | null = null;
        if (row.rentalCarpark && row.unitCode) {
          const cp = await ensureCarpark(session, propertyId, row.unitCode, row.unitCode, row.rentalCarpark);
          carparkBayId = cp.id;
        }
        await db.$transaction(async (tx) => {
          const plan = await planParty(tx, session.orgId, row);
          rr.partyAction = plan.action;
          if (plan.action === "create") counts.partiesCreated++;
          else if (plan.action === "match") counts.partiesMatched++;
          const partyId = await executePartyPlan(tx, session, plan);
          if (!partyId) {
            counts.rowsSkipped++;
            rr.tenancyAction = "skip";
            return;
          }
          const roomT = await ensureTenancy(tx, session, row, {
            partyId,
            propertyId,
            unitId: roomListing.id,
            monthlyRent: row.rentalRoom ?? 0,
            now,
          });
          rr.tenancyAction = roomT.created ? "create" : "exists";
          if (roomT.created) counts.tenanciesCreated++;
          if (carparkBayId && row.rentalCarpark) {
            const ca = await ensureCarparkAssignment(
              tx,
              session,
              carparkBayId,
              roomT.tenancyId,
              row.rentalCarpark,
            );
            rr.carparkAction = ca.created ? "create" : "exists";
            if (ca.created) counts.tenanciesCreated++;
          }
          const meterRes = await seedMeterBaseline(tx, session, row, {
            unitId: roomListing.id,
            periodMonth: firstOfMonth(now),
          });
          rr.meterAction = meterRes.created ? "seed" : "exists";
        });
      }
    } catch (e) {
      // Per-row isolation: one failing row is counted as a conflict; loop continues.
      counts.conflicts++;
      rr.conflict = (e as Error).message;
    }
    reportRows.push(rr);
  }

  // Report uploaded in BOTH modes; ledger finalized regardless of upload outcome.
  let reportKey: string | null = null;
  let errorText: string | undefined;
  try {
    const csv = buildReportCsv(reportRows, agents, roomTypes);
    const iso = now.toISOString().replace(/[:.]/g, "-");
    reportKey = await uploadReport(session.orgId, run.id, csv, iso);
  } catch (e) {
    errorText = `report upload failed: ${(e as Error).message}`;
  }

  await finishImportRun(run.id, {
    status: "completed",
    rowsParsed: counts.rowsParsed,
    partiesCreated: counts.partiesCreated,
    partiesMatched: counts.partiesMatched,
    tenanciesCreated: counts.tenanciesCreated,
    rowsSkipped: counts.rowsSkipped,
    conflicts: counts.conflicts,
    reportKey: reportKey ?? undefined,
    errorText,
  });
  return ok({ runId: run.id, counts, reportKey });
}

export async function listRunsService(
  session: ImportSession,
  limit = 50,
): Promise<Result<unknown[]>> {
  const runs = await listImportRuns(session.orgId, limit);
  return ok(runs);
}

export async function getRunService(
  session: ImportSession,
  id: string,
): Promise<Result<unknown>> {
  const run = await getImportRun(session.orgId, id);
  if (!run) return err(404, "import run not found");
  let reportUrl: string | null = null;
  if (run.reportKey) {
    try {
      reportUrl = await createSignedDownloadUrl(run.reportKey, {
        filename: "import-report.csv",
        ttlSeconds: 3600,
      });
    } catch {
      // report URL is best-effort — a signing failure must not 500 the detail view.
      reportUrl = null;
    }
  }
  return ok({ ...run, reportUrl });
}
