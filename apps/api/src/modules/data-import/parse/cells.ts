export type RentalSplit = { room: number | null; carpark: number | null };

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "900+120" → {room:900, carpark:120}; "1000" → {room:1000, carpark:null}. */
export function parseRentalExpression(raw: unknown): RentalSplit {
  if (raw === null || raw === undefined || raw === "") return { room: null, carpark: null };
  const s = String(raw).trim();
  if (s.includes("+")) {
    const parts = s.split("+").map((p) => toNumber(p));
    return { room: parts[0] ?? null, carpark: parts[1] ?? null };
  }
  return { room: toNumber(s), carpark: null };
}

/** Split a multi-person cell (newline / & / slash). Primary tenant is element 0. */
export function splitMultiTenant(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(/[\r\n]+|\s*&\s*|\s*\/\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function parseGender(raw: unknown): "male" | "female" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.startsWith("m")) return "male";
  if (s.startsWith("f")) return "female";
  return null;
}

export function parseIdType(raw: unknown): "NRIC" | "passport" | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length === 12 ? "NRIC" : "passport";
}

/** "1Y"/"1 YEAR" → 12, "6M" → 6, "1Y+1Y" → 12 (first term; chains deferred v1). */
export function parseTermMonths(raw: unknown): number | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return null;
  const first = s.split("+")[0]!.trim();
  const yMatch = first.match(/(\d+)\s*Y(EAR)?/);
  if (yMatch) return parseInt(yMatch[1]!, 10) * 12;
  const mMatch = first.match(/(\d+)\s*M(ONTH)?/);
  if (mMatch) return parseInt(mMatch[1]!, 10);
  return null;
}

export function parseDateCell(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim();
  if (!/\d{4}/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type ReadingResult = { value: number | null; monotonic: boolean };

/** Latest cumulative meter reading = rightmost non-empty; flags non-monotonic data. */
export function latestCumulativeReading(values: Array<number | null | undefined>): ReadingResult {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return { value: null, monotonic: true };
  let monotonic = true;
  for (let i = 1; i < nums.length; i++) if (nums[i]! < nums[i - 1]! - 0.001) monotonic = false;
  return { value: nums[nums.length - 1]!, monotonic };
}
