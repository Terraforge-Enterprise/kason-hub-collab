// Typed react-query hook for the party typeahead used by the receive-payment /
// correction drawers. Backs the tenant + owner search endpoints
// (GET /parties/{tenants,owners}/search?q=). Debounce is the CALLER's job — this
// hook fetches whatever settled `q` it is handed.
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

/** Which party register to search — picks the endpoint + query-key scope. */
export type PartyCounterparty = "tenant" | "owner";

/**
 * Normalized typeahead hit. `subtitle` is the friendly phone (or its canonical
 * fallback) so the picker can render a secondary line; absent when the party has
 * no phone on file.
 */
export type PartySearchHit = {
  id: string;
  name: string;
  subtitle?: string;
};

/**
 * Raw shape of both search endpoints' `data[]` rows. Tenants carry masked-IC
 * fields the owner endpoint omits; only the id/name/phone triple is read here.
 */
type PartySearchRow = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  formattedPhone: string | null;
};

/**
 * Typeahead against the tenant OR owner register. `tenant` → GET
 * /parties/tenants/search, `owner` → GET /parties/owners/search. Returns a
 * normalized `{ id, name, subtitle? }[]` (name = displayName, subtitle = the
 * friendly phone). DISABLED when `q` is empty/whitespace or `opts.enabled ===
 * false`. Query key scoped by counterparty + q so tenant and owner hits never
 * collide in the cache.
 */
export function useSearchParties(
  counterparty: PartyCounterparty,
  q: string,
  opts?: { enabled?: boolean },
) {
  const trimmed = q.trim();
  const endpoint = counterparty === "tenant" ? "/parties/tenants/search" : "/parties/owners/search";
  return useQuery({
    queryKey: ["parties-search", counterparty, trimmed],
    queryFn: async (): Promise<PartySearchHit[]> => {
      const res = await apiFetch<{ data: PartySearchRow[] }>(
        `${endpoint}?q=${encodeURIComponent(trimmed)}`,
      );
      return res.data.map((r) => {
        const subtitle = r.formattedPhone ?? r.primaryPhone ?? undefined;
        return { id: r.id, name: r.displayName, ...(subtitle ? { subtitle } : {}) };
      });
    },
    enabled: opts?.enabled !== false && trimmed.length > 0,
  });
}
