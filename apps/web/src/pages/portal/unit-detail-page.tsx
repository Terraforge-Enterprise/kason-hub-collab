import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Ruler,
  Wallet,
  User as UserIcon,
  Download,
  Image as ImageIcon,
  Film,
  Building2,
  Compass,
  Sofa,
  Coins,
  CalendarX,
  ListChecks,
  FileText,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { portalApiFetch, PortalApiError } from "@/lib/portal-api";
import { listingLabel } from "@/lib/listing-status";
import { formatRM, formatDate } from "@/components/format";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { downloadAllMedia } from "@/lib/download-media";
import { listOwnPortalUnits } from "@/api/portal-inventory";

// Convert "fully_furnished" → "Fully furnished" for display. The seed and
// admin form use snake_case enums; the agent UI shows them human-readable.
function formatFurnishing(value: string | null): string | null {
  if (!value) return null;
  return value
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* ── Types ─────────────────────────────────────────────────────────────────── */

// Prisma Decimal columns arrive as strings over JSON (Decimal.toJSON() yields
// a string for precision). The UI coerces with `Number(...)` at render time.
type Decimalish = string | number;

// Detail-shape — same as InventoryListing from @/features/inventory-explorer
// minus `coverPhotoUrl` (only the list endpoint signs cover thumbnails).
// Keep in sync.
type PortalUnit = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  rentalRate: Decimalish | null;
  currency: string;
  moveInDate: string | null;
  readyNow: boolean;
  inChargeName: string | null;
  inChargePartyId: string | null;
  photoKeys: string[];
  videoKeys: string[];
  title: string | null;
  description: string | null;
  amenities: { id: string; name: string }[];
  furnishingLevel: string | null;
  floor: number | null;
  facing: string | null;
  depositMonths: number | null;
  utilitiesDepositMonths: number | null;
  accessCardDepositPerPcs: number | null;
  accessCardQuantity: number | null;
  parkingQuantity: number | null;
  parkingNumbers: string[];
  currentTenancyStartDate: string | null;
  currentTenancyEndDate: string | null;
  occupancyStatus: string;
  vacantSince: string | null;
  listingStatus: string;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  sourcingAgentId: string | null;
  property: { name: string; city: string | null };
};

type MediaUrls = { photos: string[]; videos: string[] };

type DownloadState =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "downloading" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function PortalUnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [downloadState, setDownloadState] = useState<DownloadState>({ kind: "idle" });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const unitQuery = useQuery({
    queryKey: ["portal-listing", id],
    queryFn: () => portalApiFetch<PortalUnit>(`/listings/${id}`),
    // Don't retry on 404 — visibility can change mid-session and the agent
    // should see the empty state immediately rather than stale data.
    retry: (failureCount, err) => {
      if (err instanceof PortalApiError && err.status === 404) return false;
      return failureCount < 2;
    },
    enabled: !!id,
  });

  // Lazily fetch signed URLs once for the carousel + download button. Separate
  // query so the detail render doesn't block on S3 signatures.
  const mediaQuery = useQuery({
    queryKey: ["portal-listing-media", id],
    queryFn: () =>
      portalApiFetch<MediaUrls>(`/listings/${id}/media/download-urls`),
    enabled: !!id && !!unitQuery.data,
    staleTime: 25 * 60_000, // signed URLs default to 30 min TTL — refetch before that
  });

  // Side-load the agent's own-units list so we can surface `pendingChanges`
  // here. The `/listings/:id` endpoint is shared with the read-only inventory
  // view and intentionally does NOT expose the post-approval edit surface;
  // the lifecycle data lives on /portal-api/inventory/units (own-only).
  // Same queryKey as my-uploads-page so the cache is shared.
  const ownUnitsQuery = useQuery({
    queryKey: ["portal-my-uploads"],
    queryFn: listOwnPortalUnits,
  });
  // ownEntry matches when the listing page id is the agent's own approved
  // listing — back-pointing via `approvedListingId` — or when it's the raw
  // submission id (pending / needs_amendment view).
  const ownEntry = ownUnitsQuery.data?.find(
    (u) => u.id === id || u.approvedListingId === id,
  );
  // After the three-table refactor, post-approval amendments are filed as
  // separate UnitSubmission rows with parentListingId set (rather than as
  // pendingChanges JSON on the Listing). For an approved listing, "has
  // pending changes" means there's an own-entry pointing at this id whose
  // submissionState is pending or needs_amendment AND parentListingId
  // matches this listing id.
  const hasPendingChanges = !!ownUnitsQuery.data?.some(
    (u) =>
      u.parentListingId === id &&
      (u.submissionState === "pending" ||
        u.submissionState === "needs_amendment"),
  );

  const photoCount = mediaQuery.data?.photos.length ?? 0;
  useEffect(() => {
    if (lightboxIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxIndex(null);
      else if (e.key === "ArrowRight") setLightboxIndex((i) => (i === null || photoCount === 0 ? i : (i + 1) % photoCount));
      else if (e.key === "ArrowLeft") setLightboxIndex((i) => (i === null || photoCount === 0 ? i : (i - 1 + photoCount) % photoCount));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, photoCount]);

  if (unitQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-48 bg-muted rounded" />
        <div className="h-80 bg-muted rounded-xl" />
        <div className="h-48 bg-muted rounded-xl" />
      </div>
    );
  }

  if (unitQuery.isError) {
    const notFound =
      unitQuery.error instanceof PortalApiError && unitQuery.error.status === 404;
    return (
      <div className="space-y-4">
        <Link
          to="/portal/inventory"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to inventory
        </Link>
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {notFound
                ? "This unit is no longer available to you, or the link is invalid."
                : "Failed to load unit details. Please try again."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const unit = unitQuery.data;
  if (!unit) return null;

  const photoUrls = mediaQuery.data?.photos ?? [];
  const videoUrls = mediaQuery.data?.videos ?? [];
  const hasMedia = unit.photoKeys.length > 0 || unit.videoKeys.length > 0;

  async function handleDownloadAll() {
    setDownloadState({ kind: "fetching" });
    try {
      // Always re-sign URLs right before download so tokens are fresh.
      const urls = await portalApiFetch<MediaUrls>(
        `/listings/${id}/media/download-urls`,
      );
      const all = [...urls.photos, ...urls.videos];
      if (all.length === 0) {
        setDownloadState({ kind: "error", message: "This unit has no media to download." });
        return;
      }
      setDownloadState({ kind: "downloading" });
      await downloadAllMedia(all, `${unit?.property?.name ?? "unit"}-${unit?.unitCode ?? id}`);
      setDownloadState({ kind: "done" });
    } catch (err) {
      const message =
        err instanceof PortalApiError || err instanceof Error
          ? err.message
          : "Download failed";
      setDownloadState({ kind: "error", message });
    }
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/portal/inventory"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to inventory
      </Link>

      {/* Pending re-approval banner — agent edited this approved unit and
          the patch is sitting in `pendingChanges` waiting on admin sign-off.
          Below this banner the page still renders the LIVE approved values,
          so we tell the agent that explicitly. */}
      {hasPendingChanges && (
        <Callout variant="info" title="Pending re-approval">
          Your edits are awaiting admin review. The numbers below show the
          currently approved values; once an admin approves, your changes go
          live.
        </Callout>
      )}

      {/* Needs-amendment banner — admin asked the agent to fix something.
          Shows the note inline + an Amend CTA into /portal/inventory/:id/edit.
          After the three-table refactor, the submission row carries its own
          submissionState; reject notes still use the legacy "REJECTED:"
          prefix so they don't double-render in the warning bucket. */}
      {ownEntry &&
        ownEntry.submissionState === "needs_amendment" &&
        ownEntry.amendmentNote &&
        !ownEntry.amendmentNote.startsWith("REJECTED:") && (
          <Callout variant="warning" title="Admin requested changes">
            <div className="space-y-3">
              <p>{ownEntry.amendmentNote}</p>
              <Link to={`/portal/inventory/${ownEntry.id}/edit`}>
                <Button variant="gold" size="sm">
                  Amend submission
                </Button>
              </Link>
            </div>
          </Callout>
        )}

      {/* Pending (no admin note yet) — agent can still tweak before admin
          looks at it. Quieter affordance than the needs-amendment banner. */}
      {ownEntry &&
        ownEntry.submissionState === "pending" &&
        !ownEntry.amendmentNote && (
          <div className="flex justify-end">
            <Link to={`/portal/inventory/${ownEntry.id}/edit`}>
              <Button variant="outline" size="sm">
                Edit submission
              </Button>
            </Link>
          </div>
        )}

      {/* Header */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-foreground truncate">
                {unit.property?.name ?? "Unknown property"}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="font-mono">{unit.unitCode}</span>
                {unit.property?.city && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{unit.property.city}</span>
                  </>
                )}
                <span aria-hidden>·</span>
                <span className="capitalize">{unit.unitType}</span>
              </div>
              {unit.title && (
                <p className="mt-2 text-base text-foreground/90">
                  {unit.title}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {/* Non-active badge — only rendered when the requester is the
                    in-charge agent on a non-active unit (other agents never
                    receive non-active rows from the API). Tells them the
                    unit isn't live yet so they don't pitch it prematurely.
                    Suppressed when readyNow=true to match compositeStatusLabel:
                    "Ready Now" wins over draft/archived. */}
                {unit.listingStatus !== "active" && !unit.readyNow && (
                  <Badge
                    variant="outline"
                    className="border-amber-400/50 bg-amber-500/10 text-amber-300"
                  >
                    {listingLabel(unit.listingStatus)}
                  </Badge>
                )}
                {unit.readyNow ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-400/50 bg-emerald-500/10 text-emerald-300"
                  >
                    Ready now
                  </Badge>
                ) : unit.moveInDate ? (
                  <Badge
                    variant="outline"
                    className="border-amber-400/50 bg-amber-500/10 text-amber-300"
                  >
                    Move-in {formatDate(unit.moveInDate)}
                  </Badge>
                ) : null}
                {unit.sourceFlag === "AGENT_SOURCED" && (
                  <Badge variant="outline" className="border-sky-400/50 bg-sky-500/10 text-sky-300">
                    Agent sourced
                  </Badge>
                )}
              </div>
            </div>
            <Button
              variant="gold"
              size="lg"
              onClick={handleDownloadAll}
              disabled={
                !hasMedia ||
                downloadState.kind === "fetching" ||
                downloadState.kind === "downloading"
              }
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              {downloadState.kind === "fetching"
                ? "Preparing…"
                : downloadState.kind === "downloading"
                  ? "Downloading…"
                  : "Download all media"}
            </Button>
          </div>
          {downloadState.kind === "error" && (
            <p
              role="alert"
              className="mt-3 text-xs text-rose-400"
            >
              {downloadState.message}
            </p>
          )}
          {downloadState.kind === "done" && (
            <p className="mt-3 text-xs text-emerald-400">Media download complete.</p>
          )}
        </CardContent>
      </Card>

      {/* Photo gallery */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4" /> Photos
          </h2>
          {unit.photoKeys.length === 0 ? (
            <div className="aspect-[16/9] rounded-lg bg-muted/40 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">No photos uploaded.</p>
            </div>
          ) : mediaQuery.isLoading ? (
            <div className="aspect-[16/9] rounded-lg bg-muted animate-pulse" />
          ) : mediaQuery.isError ? (
            <div className="aspect-[16/9] rounded-lg bg-muted/40 flex items-center justify-center">
              <p className="text-sm text-rose-400">Failed to load photos.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {photoUrls.map((url, i) => (
                <div key={url} className="group relative">
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(i)}
                    aria-label={`View photo ${i + 1}`}
                    className="block w-full aspect-[4/3] rounded-lg overflow-hidden border border-border/50 hover:border-[var(--gold)] transition-colors bg-muted/40 cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-[var(--gold)]"
                  >
                    <img
                      src={url}
                      alt={`${unit.property?.name ?? "Unit"} ${unit.unitCode} photo ${i + 1}`}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                  </button>
                  <a
                    href={url}
                    download={`${unit.property?.name ?? "unit"}-${unit.unitCode}-photo-${i + 1}.${unit.photoKeys[i]?.split(".").pop() ?? "jpg"}`}
                    className="absolute top-2 right-2 p-1.5 rounded-md bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Download photo ${i + 1}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Videos */}
      {unit.videoKeys.length > 0 && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
              <Film className="h-4 w-4" /> Videos
            </h2>
            {mediaQuery.isLoading ? (
              <div className="aspect-video rounded-lg bg-muted animate-pulse" />
            ) : mediaQuery.isError || videoUrls.length === 0 ? (
              <div className="aspect-video rounded-lg bg-muted/40 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">Video previews unavailable.</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {videoUrls.map((url, i) => (
                  <div key={url} className="relative group">
                    <video
                      src={url}
                      controls
                      preload="metadata"
                      className="w-full rounded-lg border border-border/50 bg-black"
                    >
                      <track kind="captions" label={`Video ${i + 1}`} />
                    </video>
                    <a
                      href={url}
                      download={`${unit.property?.name ?? "unit"}-${unit.unitCode}-video-${i + 1}.${unit.videoKeys[i]?.split(".").pop() ?? "mp4"}`}
                      className="absolute top-2 right-2 p-2 rounded-md bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label={`Download video ${i + 1}`}
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Key facts */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
            Key facts
          </h2>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Fact
              icon={<BedDouble className="h-4 w-4" />}
              label="Bedrooms"
              value={unit.bedrooms != null ? String(unit.bedrooms) : "—"}
            />
            <Fact
              icon={<Bath className="h-4 w-4" />}
              label="Bathrooms"
              value={unit.bathrooms != null ? String(unit.bathrooms) : "—"}
            />
            <Fact
              icon={<Ruler className="h-4 w-4" />}
              label="Floor area"
              value={unit.floorArea != null ? `${unit.floorArea} sqft` : "—"}
            />
            <Fact
              icon={<Wallet className="h-4 w-4" />}
              label="Monthly rental"
              value={unit.rentalRate != null ? formatRM(Number(unit.rentalRate)) : "—"}
            />
            {unit.floor != null && (
              <Fact
                icon={<Building2 className="h-4 w-4" />}
                label="Floor"
                value={`${unit.floor}`}
              />
            )}
            {unit.facing && (
              <Fact
                icon={<Compass className="h-4 w-4" />}
                label="Facing"
                value={unit.facing}
              />
            )}
            {unit.furnishingLevel && (
              <Fact
                icon={<Sofa className="h-4 w-4" />}
                label="Furnishing"
                value={formatFurnishing(unit.furnishingLevel) ?? "—"}
              />
            )}
            {unit.inChargeName && (
              <Fact
                icon={<UserIcon className="h-4 w-4" />}
                label="In charge"
                value={unit.inChargeName}
              />
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Lease terms — deposit + how long it's been vacant. Shown only when
          either piece is populated; agents need this for tenant-cash math
          and "how soon could I close" framing. */}
      {(unit.depositMonths != null || unit.vacantSince) && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
              Lease terms
            </h2>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {unit.depositMonths != null && (
                <Fact
                  icon={<Coins className="h-4 w-4" />}
                  label="Deposit"
                  value={`${unit.depositMonths} ${unit.depositMonths === 1 ? "month" : "months"}`}
                />
              )}
              {unit.vacantSince && (
                <Fact
                  icon={<CalendarX className="h-4 w-4" />}
                  label="Vacant since"
                  value={formatDate(unit.vacantSince)}
                />
              )}
            </dl>
          </CardContent>
        </Card>
      )}

      {/* Amenities */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
            <ListChecks className="h-4 w-4" /> Amenities
          </h2>
          {unit.amenities.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">None listed.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {unit.amenities.map((a) => (
                <Badge
                  key={a.id}
                  variant="outline"
                  className="capitalize border-border/50"
                >
                  {a.name}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Deposits & parking */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Deposits & parking
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Rental deposit</div>
              <div>
                {unit.depositMonths != null
                  ? `${unit.depositMonths} ${unit.depositMonths > 1 ? "months" : "month"}`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Utilities deposit</div>
              <div>
                {unit.utilitiesDepositMonths != null
                  ? `${unit.utilitiesDepositMonths} ${unit.utilitiesDepositMonths > 1 ? "months" : "month"}`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Access cards</div>
              <div>{unit.accessCardQuantity != null ? `${unit.accessCardQuantity} pc(s)` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Access card / pc</div>
              <div>{unit.accessCardDepositPerPcs != null ? `RM ${unit.accessCardDepositPerPcs.toLocaleString()}` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Parking</div>
              <div>{unit.parkingQuantity != null ? `${unit.parkingQuantity} spot(s)` : "—"}</div>
            </div>
            {unit.parkingNumbers.length > 0 && (
              <div className="col-span-2 sm:col-span-3">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Parking numbers</div>
                <div className="font-mono">{unit.parkingNumbers.join(", ")}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tenancy — only shown for occupied units with a known end date */}
      {unit.occupancyStatus === "occupied" && unit.currentTenancyEndDate && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-5 space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Tenancy
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Move-in</div>
                <div>
                  {unit.currentTenancyStartDate
                    ? unit.currentTenancyStartDate.slice(0, 10)
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Expected move-out</div>
                <div>{unit.currentTenancyEndDate.slice(0, 10)}</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground italic">
              Scheduled lease end. The admin adjusts manually when leases roll.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Description */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4" /> Description
          </h2>
          {unit.description ? (
            <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {unit.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No description provided.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Photo lightbox */}
      {lightboxIndex !== null && photoUrls[lightboxIndex] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Photo ${lightboxIndex + 1} of ${photoUrls.length}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 animate-fade-in-up"
          onClick={() => setLightboxIndex(null)}
        >
          <button
            type="button"
            aria-label="Close photo"
            onClick={() => setLightboxIndex(null)}
            className="absolute top-4 right-4 p-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>

          {photoUrls.length > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous photo"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null ? i : (i - 1 + photoUrls.length) % photoUrls.length,
                  );
                }}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="Next photo"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex((i) =>
                    i === null ? i : (i + 1) % photoUrls.length,
                  );
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}

          <img
            src={photoUrls[lightboxIndex]}
            alt={`${unit.property?.name ?? "Unit"} ${unit.unitCode} photo ${lightboxIndex + 1}`}
            className="max-h-[90vh] max-w-[92vw] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />

          {photoUrls.length > 1 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/50 text-white text-xs">
              {lightboxIndex + 1} / {photoUrls.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────────────── */

function Fact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <dt className="text-xs text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}
