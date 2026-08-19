// Public-card fetch helper.
//
// Uses raw `fetch` — NOT @/lib/api-client (apiFetch carries admin auth) and
// NOT @/lib/portal-api (portalApiFetch carries portal auth). The public
// endpoint is unauthenticated; sending auth headers from a public visitor's
// browser would be both pointless (no session) and a leak risk. The ESLint
// guard at eslint.config.mjs `files: ["src/pages/card/**"]` enforces this for
// pages-tree code; we live under src/public-card/ but follow the same rule.

import type { PublicCardDto } from "./types";

const API_BASE = import.meta.env.VITE_PUBLIC_API_BASE ?? "";

export async function fetchPublicCard(
  token: string,
  signal?: AbortSignal,
): Promise<PublicCardDto | null> {
  const res = await fetch(
    `${API_BASE}/public-api/card/${encodeURIComponent(token)}`,
    { signal },
  );
  // Per spec §6.3 / §9.3, the API returns an identical 404 for every failure
  // case (token missing, expired, revoked, agent inactive, version not
  // approved, feature flag off). UI MUST NOT distinguish between them.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Public card fetch failed: ${res.status}`);
  }
  return res.json();
}
