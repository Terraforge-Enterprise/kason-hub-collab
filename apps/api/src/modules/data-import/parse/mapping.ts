import type { RawTenantRow } from "../types";

export type Count = { value: string; count: number };

export function distinctCounts(rows: RawTenantRow[], field: "agentLabel" | "roomName"): Count[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = r[field];
    if (v) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].map(([value, count]) => ({ value, count }));
}

/** Apply a reviewed raw→canonical map; unmapped values pass through unchanged (RAW). */
export function applyMapping(raw: string | null, map: Map<string, string>): string | null {
  if (raw === null) return null;
  return map.get(raw) ?? raw;
}

/** Parse a reviewed CSV ("raw,canonical" per line, header tolerated) into a map. */
export function parseMappingCsv(csv: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of csv.split(/\r?\n/)) {
    const [raw, canonical] = line.split(",").map((s) => s?.trim() ?? "");
    if (!raw || !canonical || raw.toLowerCase() === "raw") continue;
    map.set(raw, canonical);
  }
  return map;
}
