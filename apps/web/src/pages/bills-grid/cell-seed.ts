// Bills & Expenses Grid — shared cell-seed helpers.
//
// `cleaningSeed` is read by BOTH grid-table.tsx's `seedValue` (on-screen) AND
// export-xlsx.ts (Excel export), so a never-Saved month's auto-filled
// recurring cleaning amount (R7) shows IDENTICALLY in both surfaces. Before
// this file existed, export-xlsx.ts read `entry?.cleaning` only — dropping
// the bearerConfig fallback the grid displays, so an unsaved month exported
// blank where the screen showed the recurring default (user decision:
// "export mirrors the on-screen view").
//
// Display-only: never a calc input, never touched by Save/Bill.
import type { GridRow } from "@/api/bills-grid";

/** Cleaning seed: the snapshotted entry value, else (R7) the recurring
 * auto-fill amount when nothing was ever Saved. Mirrors grid-table.tsx's
 * PREVIOUS inline seedValue expression EXACTLY — do not let the two diverge
 * again. */
export function cleaningSeed(row: GridRow): string {
  return row.entry?.cleaning ?? row.bearerConfig.cleaningRecurringAmount ?? "";
}
