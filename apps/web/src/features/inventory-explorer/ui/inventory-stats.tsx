import { formatRM } from "@/components/format";
import type { InventoryStats } from "../logic/derive-stats";

export function InventoryStatsStrip({ stats, total }: { stats: InventoryStats; total: number }) {
  const filtered = stats.count !== total;
  return (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {filtered ? <><span className="font-semibold text-foreground">{stats.count}</span> of {total} units match</> : <><span className="font-semibold text-foreground">{stats.count}</span> units</>}
      {" · "}<span className="text-foreground">{stats.readyNowCount}</span> ready now
      {stats.avgRental != null && <>{" · avg "}<span className="text-foreground">{formatRM(stats.avgRental)}</span>/month</>}
      {" · "}<span className="text-foreground">{stats.buildingCount}</span> {stats.buildingCount === 1 ? "building" : "buildings"}
    </p>
  );
}
