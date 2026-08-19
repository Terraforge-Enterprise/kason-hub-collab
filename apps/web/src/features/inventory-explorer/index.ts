// apps/web/src/features/inventory-explorer/index.ts
//
// Public API for the inventory-explorer feature module. External consumers
// (portal page, admin page) should import ONLY from this file. Internal
// modules under domain/, logic/, hooks/, ui/ are implementation details.

export { InventoryExplorer, type InventoryExplorerProps } from "./ui/inventory-explorer";
export { useInventoryUrlState } from "./hooks/use-inventory-filters";
export type {
  InventoryListing,
  InventoryFilters,
  SortKey,
  ViewMode,
  GroupKey,
  SourceFilter,
  Bucket,
} from "./domain/types";
// Deprecated alias kept for one release.
export type { PortalUnit } from "./domain/types";
