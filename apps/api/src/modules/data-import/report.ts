import { putObject } from "../../lib/storage";
import type { ReportRow } from "./types";
import type { Count } from "./parse/mapping";

export function buildReportCsv(rows: ReportRow[], agents: Count[], roomTypes: Count[]): string {
  const head = "sheet,row,unitCode,room,tenant,partyAction,tenancyAction,carpark,meter,conflict,notes";
  const clean = (s: string | null): string => (s ?? "").replace(/[\n,]/g, " ");
  const body = rows.map((r) =>
    [
      r.sheet,
      r.row,
      r.unitCode ?? "",
      r.room ?? "",
      r.tenantMasked,
      r.partyAction,
      r.tenancyAction,
      r.carparkAction ?? "",
      r.meterAction ?? "",
      r.conflict ?? "",
      clean(r.notes),
    ].join(","),
  );
  const agentSec = [
    "",
    "# AGENT LABELS (raw,count) — review then map to canonical",
    "raw,count",
    ...agents.map((a) => `${a.value},${a.count}`),
  ];
  const roomSec = [
    "",
    "# ROOM NAMES (raw,count) — review then map to canonical",
    "raw,count",
    ...roomTypes.map((a) => `${a.value},${a.count}`),
  ];
  return [head, ...body, ...agentSec, ...roomSec].join("\n");
}

export async function uploadReport(
  orgId: string,
  importRunId: string,
  csv: string,
  iso: string,
): Promise<string> {
  const key = `imports/${orgId}/${importRunId}/report-${iso}.csv`;
  await putObject(key, Buffer.from(csv, "utf-8"), "text/csv");
  return key;
}
