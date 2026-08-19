import { apiFetch } from "@/lib/api-client";
import type { InventoryListing } from "@/features/inventory-explorer";

/**
 * Admin-side wrapper around GET /api/listings/explorer.
 *
 * Returns the same row shape the agent sees at /portal-api/listings (so the
 * Agent View tab on /inventory can reuse the shared inventory-explorer UI),
 * but without the per-agent visibility filter — operators see every unit in
 * the org.
 */
export async function listExplorerUnits(): Promise<InventoryListing[]> {
  const res = await apiFetch<{ rows: InventoryListing[] }>("/listings/explorer");
  return res.rows;
}
