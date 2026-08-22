// apps/web/src/features/inventory-explorer/ui/unit-card.tsx
import { Link, useNavigate } from "react-router-dom";
import {
  BedDouble, Bath, Image as ImageIcon, User as UserIcon,
  ClipboardCopy, Link as LinkIcon, Download, Star,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { formatRM, formatDate } from "@/components/format";
import type { InventoryListing, ViewMode } from "../domain/types";
import { ENDING_SOON_WINDOW_DAYS } from "../domain/types";
import { classifyOccupancy } from "../logic/occupancy";

// Caller-supplied `to` is the canonical destination for everything the card
// links to (main link, share-URL clipboard, download nav). The card never
// hardcodes /portal/* — that's how the cross-envelope navigation bug shipped
// the first time. See docs/superpowers/specs/2026-05-09-inventory-explorer-shared-module-design.md.
type Props = { unit: InventoryListing; to: string; view: ViewMode; today?: Date };

function formatFurnishing(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function buildSummary(u: InventoryListing): string {
  const lines = [
    u.title ? `**${u.title}**` : "",
    `**${u.property?.name ?? "Unit"}** — ${u.unitCode}`,
    u.property?.city ? u.property.city : "",
    `${u.bedrooms ?? 0} bed · ${u.bathrooms ?? 0} bath${u.floorArea ? ` · ${u.floorArea} sqft` : ""}`,
    [
      u.floor != null ? `Floor ${u.floor}` : "",
      u.facing ? `${u.facing} facing` : "",
      formatFurnishing(u.furnishingLevel),
    ]
      .filter(Boolean)
      .join(" · "),
    u.rentalRate != null ? `Rental: ${formatRM(Number(u.rentalRate))}/month` : "Rental: —",
    u.depositMonths != null
      ? `Deposit: ${u.depositMonths} ${u.depositMonths === 1 ? "month" : "months"}`
      : "",
    u.readyNow ? "Status: Ready now" : u.moveInDate ? `Move-in: ${formatDate(u.moveInDate)}` : "",
    u.amenities.length > 0 ? `Amenities: ${u.amenities.map((a) => a.name).join(", ")}` : "",
    u.description ? `\n${u.description}` : "",
    u.inChargeName ? `\nIn charge: ${u.inChargeName}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function copy(text: string, msg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(msg);
  } catch {
    toast.error("Copy failed — clipboard unavailable.");
  }
}

function StatusBadges({ unit, today }: { unit: InventoryListing; today: Date }) {
  const cls = classifyOccupancy(unit, ENDING_SOON_WINDOW_DAYS, today);
  const endDate = unit.currentTenancyEndDate
    ? formatDate(unit.currentTenancyEndDate)
    : null;
  return (
    <div className="absolute top-2 left-2 flex gap-1.5 flex-wrap max-w-[calc(100%-1rem)]">
      {unit.unitType !== "" && (
        <Badge variant="outline" className="border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-300">
          {unit.unitType}
        </Badge>
      )}
      {cls === "ready" && (
        <Badge variant="outline" className="border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
          Ready now
        </Badge>
      )}
      {cls === "upcoming" && unit.moveInDate && (
        <Badge variant="outline" className="border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          Move-in {formatDate(unit.moveInDate)}
        </Badge>
      )}
      {cls === "ending-soon" && (
        <Badge variant="outline" className="border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          {endDate ? `Available soon — ${endDate}` : "Available soon"}
        </Badge>
      )}
      {cls === "occupied" && (
        <Badge variant="outline" className="border-rose-400/50 bg-rose-500/10 text-rose-700 dark:text-rose-300">
          {endDate ? `Occupied — until ${endDate}` : "Occupied"}
        </Badge>
      )}
      {unit.furnishingLevel && (
        <Badge variant="outline" className="border-violet-400/50 bg-violet-500/10 text-violet-700 dark:text-violet-300">
          {formatFurnishing(unit.furnishingLevel)}
        </Badge>
      )}
      {/* Lineage badge — listing was sourced by an agent. Reads
          `sourcingAgentId` directly (post three-table refactor) instead of
          the deprecated derived `sourceFlag`. */}
      {unit.sourcingAgentId != null && (
        <Badge variant="outline" className="border-sky-400/50 bg-sky-500/10 text-sky-700 dark:text-sky-300">
          Agent sourced
        </Badge>
      )}
    </div>
  );
}

function QuickActions({ unit, to }: { unit: InventoryListing; to: string }) {
  const shareUrl = `${window.location.origin}${to}`;
  const navigate = useNavigate();
  return (
    <div className="absolute bottom-0 left-0 right-0 flex items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); copy(buildSummary(unit), "Summary copied"); }}
        aria-label="Copy listing summary"
        title="Copy listing summary"
        className="p-1.5 rounded-md bg-black/40 text-white hover:bg-black/60"
      >
        <ClipboardCopy className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); copy(shareUrl, "Link copied"); }}
        aria-label="Copy share link"
        title="Copy share link"
        className="p-1.5 rounded-md bg-black/40 text-white hover:bg-black/60"
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`${to}#download`); }}
        aria-label="Open detail to download all media"
        title="Download all media"
        className="p-1.5 rounded-md bg-black/40 text-white hover:bg-black/60"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled
        aria-label="Save to shortlist"
        title="Coming soon"
        className="p-1.5 rounded-md bg-black/40 text-white/60 cursor-not-allowed"
      >
        <Star className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CoverFallback({ unitId, hasPhotos }: { unitId: string; hasPhotos: boolean }) {
  if (import.meta.env.DEV && hasPhotos) {
    console.warn(`[portal-inventory] missing coverPhotoUrl for unit ${unitId} — backend not signing the cover thumbnail.`);
  }
  return <ImageIcon className="h-10 w-10 text-muted-foreground/60" />;
}

function FactsRow({ unit }: { unit: InventoryListing }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {unit.bedrooms != null && (
        <span className="flex items-center gap-1"><BedDouble className="h-3.5 w-3.5" />{unit.bedrooms} bed</span>
      )}
      {unit.bathrooms != null && (
        <span className="flex items-center gap-1"><Bath className="h-3.5 w-3.5" />{unit.bathrooms} bath</span>
      )}
      {unit.floorArea != null && <span>{unit.floorArea} sqft</span>}
    </div>
  );
}

export function UnitCard({ unit, to, view, today = new Date() }: Props) {
  if (view === "list") {
    return (
      <Link
        to={to}
        className="group flex items-center gap-4 rounded-xl border border-border/50 bg-background/60 backdrop-blur-xl p-3 hover:border-[var(--gold)]/50 hover:shadow-md transition-all"
      >
        <div className="h-16 w-24 rounded-md overflow-hidden bg-muted/40 flex items-center justify-center shrink-0">
          {unit.coverPhotoUrl ? (
            <img src={unit.coverPhotoUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground/60" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground truncate flex items-center gap-2">
            <span className="truncate">{unit.property?.name ?? "Unknown property"}</span>
            {unit.unitType !== "" && (
              <Badge
                variant="outline"
                className="border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-300 text-[10px] px-1.5 py-0 font-normal shrink-0"
              >
                {unit.unitType}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="font-mono">{unit.unitCode}</span>
            {unit.property?.city && (<><span aria-hidden>·</span><span>{unit.property.city}</span></>)}
          </div>
        </div>
        <FactsRow unit={unit} />
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {unit.rentalRate != null
              ? <>{formatRM(Number(unit.rentalRate))}<span className="text-xs font-normal text-muted-foreground"> /month</span></>
              : "—"}
          </div>
          {unit.inChargeName && (
            <div className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
              <UserIcon className="h-3 w-3" />{unit.inChargeName}
            </div>
          )}
        </div>
      </Link>
    );
  }

  return (
    <Link
      to={to}
      className="group block rounded-xl border border-border/50 bg-background/60 backdrop-blur-xl shadow-xl overflow-hidden transition-all hover:border-[var(--gold)]/50 hover:shadow-2xl"
    >
      <div className="aspect-[4/3] bg-muted/40 flex items-center justify-center border-b border-border/50 relative overflow-hidden">
        {unit.coverPhotoUrl ? (
          <img
            src={unit.coverPhotoUrl}
            alt={`${unit.property?.name ?? "Unit"} ${unit.unitCode}`}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <CoverFallback unitId={unit.id} hasPhotos={unit.photoKeys.length > 0} />
        )}
        {unit.photoKeys.length > 0 && (
          <span className="absolute bottom-2 right-2 rounded-md bg-background/80 px-2 py-0.5 text-xs font-medium text-foreground">
            {unit.photoKeys.length} photo{unit.photoKeys.length !== 1 ? "s" : ""}
          </span>
        )}
        <StatusBadges unit={unit} today={today} />
        <QuickActions unit={unit} to={to} />
      </div>
      <div className="p-4 space-y-3">
        <div>
          <div className="text-sm font-semibold text-foreground truncate">{unit.property?.name ?? "Unknown property"}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <span className="font-mono">{unit.unitCode}</span>
            {unit.property?.city && (<><span aria-hidden>·</span><span>{unit.property.city}</span></>)}
          </div>
        </div>
        <FactsRow unit={unit} />
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <div>
            <div className="text-xs text-muted-foreground">Rental</div>
            <div className="text-sm font-semibold text-foreground">
              {unit.rentalRate != null
                ? <>{formatRM(Number(unit.rentalRate))}<span className="text-xs font-normal text-muted-foreground"> / month</span></>
                : "—"}
            </div>
          </div>
          {unit.inChargeName && (
            <div className="text-right">
              <div className="text-xs text-muted-foreground">In charge</div>
              <div className="text-xs text-foreground flex items-center gap-1 justify-end">
                <UserIcon className="h-3 w-3" />{unit.inChargeName}
              </div>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
