// Shared query helpers — extracted so analytics.ts can reuse them without
// modifying tasks.ts (which keeps these private).
//
// Drop undefined/"" entries from a filters object. The sanitized object feeds
// BOTH the query key and the querystring, so {status: ""} and {} share one
// cache entry (mirrors users.ts's normalize-the-key convention). Empty strings
// are dropped because the API's .strict() query schemas reject "" enum values,
// and select-driven filter UIs commonly emit "" for "no filter".
export function sanitizeFilters(filters: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

export function toQueryString(sanitized: Record<string, string>): string {
  const entries = Object.entries(sanitized);
  return entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
}
