// EditApartmentShell — T4 (2026-07-10 inventory-full-edit-and-room-tenant plan).
//
// User ask (verbatim): "Edit ≠ Create — clicking Edit must show the WHOLE
// apartment like Create: owner + billing + shared header once, plus the
// room-tab header to navigate/edit every room." Today's EditUnitDialog opens
// on exactly ONE room with no way to see or switch to its siblings.
//
// APPROACH TAKEN: FALLBACK (not PRIMARY), and here is why. PRIMARY would hoist
// owner/billing/shared-basic-info OUT of the per-room body into a header
// rendered once. But the API surface does not support that split cleanly:
//   - Owner + billing model DO have a dedicated apartment endpoint (PATCH
//     /apartments/:id/shared) — those could in principle be hoisted.
//   - Shared basic-info (floor/bedrooms/bathrooms/floorArea/amenities/
//     highlights/description) has NO apartment-level endpoint. It only ever
//     propagates via a per-unit PUT with applyToExistingSiblings:true — the
//     server fans it out from whichever ROOM's PUT carried the change
//     (apartmentScopedChangedFields diffs against THAT room's own initial
//     snapshot; see edit-unit-dialog.tsx). There is no independent "apartment
//     header" write path for these fields to submit against.
// Building a truly independent header for shared-basic-info would mean
// lifting EditUnitForm's form state out of the component (controlled-mode
// refactor) so a header control and the active room's per-tab body write the
// SAME state object — a real rewrite of EditUnitForm's state ownership,
// which is exactly the money-critical surface (R5 owner/billing routing, R6
// confirm, FIX WAVE 2/3 partial-write guards) the plan says not to risk.
//
// FALLBACK instead mounts the EXISTING EditUnitForm per active tab. Owner +
// billing render on every tab (apartment-scoped, so the values are identical
// across tabs). This trade — owner/billing per-tab rather than hoisted into a
// single header — was a DELIBERATE, controller-approved choice to avoid the
// EditUnitForm state-ownership rewrite above; it is NOT sanctioned by the plan
// (the plan's T4 prescribes the hoisted header — see the Decision note added to
// that plan). The only change to edit-unit-dialog.tsx is an ADDITIVE optional
// `onSaved` prop (below) that lets this shell stay open after a room saves; the
// single-unit EditUnitDialog omits it and closes on save exactly as before, so
// every existing guard and behaviour is preserved. What the user asked for is
// delivered: every room is visible via tabs, tab-click navigates/edits every
// room, each saves via the real per-unit PUT with every existing guard, and the
// admin can edit several rooms in one sitting because a save no longer closes
// the apartment dialog.
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EditUnitForm, type FetchedUnitDetail, type UnitRowData } from "./edit-unit-dialog";
import {
  getApartmentsByProperty,
  reactivateListing,
  type ApartmentRoomSummary,
  type ApartmentSummary,
} from "@/api/inventory-units-batch";
import { occupancyLabel } from "@/lib/listing-status";
import { CarparksSection } from "./carparks-section";
import { AddRoomPanel } from "./add-room-panel";
import { Button } from "@/components/ui/button";

export type { UnitRowData } from "./edit-unit-dialog";

// Small tab header over an apartment's sibling rooms. Deliberately NOT
// PartitionRoomStrip (that component is mid-edit by a concurrent task and
// owns add/remove-room affordances this shell doesn't need) — just the
// role="tablist" navigation pattern, sized for "pick which room to edit".
function RoomTabHeader({
  rooms,
  activeRoomId,
  onSelect,
  canAddRoom,
  adding,
  onAddRoom,
}: {
  rooms: ApartmentRoomSummary[];
  activeRoomId: string | null;
  onSelect: (roomId: string) => void;
  /** Only a PARTITIONED apartment takes more rooms. On a WHOLE apartment a
   *  second room would make it MIXED — that is the Listing-mode flip's job,
   *  not an add. */
  canAddRoom: boolean;
  adding: boolean;
  onAddRoom: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Rooms in this apartment"
      className="flex flex-wrap items-center gap-1.5 border-b border-border/50 pb-3"
    >
      {rooms.map((r) => {
        const active = !adding && r.id === activeRoomId;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            id={`room-tab-${r.id}`}
            aria-selected={active}
            aria-controls={`room-tabpanel-${r.id}`}
            onClick={() => onSelect(r.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              active
                ? "bg-[#D4AF37]/15 text-[#D4AF37] ring-1 ring-[#D4AF37]/40"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            {r.unitType}
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                r.occupancyStatus === "occupied"
                  ? "bg-emerald-500"
                  : r.occupancyStatus === "reserved"
                    ? "bg-amber-500"
                    : "bg-slate-400",
              )}
              title={occupancyLabel(r.occupancyStatus ?? "vacant")}
            />
          </button>
        );
      })}
      {canAddRoom && (
        <button
          type="button"
          role="tab"
          aria-selected={adding}
          aria-controls="room-tabpanel-new"
          onClick={onAddRoom}
          className={cn(
            "ml-1 rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
            adding
              ? "bg-[#D4AF37]/15 text-[#D4AF37] ring-1 ring-[#D4AF37]/40"
              : "text-[var(--primary)] hover:bg-muted/40",
          )}
        >
          + New Room
        </button>
      )}
    </div>
  );
}

/**
 * Deactivated rooms. They are hidden from the roster's `rooms` (every consumer
 * of that field means LIVE rooms) but they still hold their room type in the
 * (apartmentId, listingType) unique index, so an admin who deactivated a room
 * by mistake has, until now, had no way to see it, reach it, or get it back.
 * Restore routes through the existing POST /listings/:id/reactivate, which
 * returns the room to `draft` — never straight to `active`.
 */
function ArchivedRoomsSection({
  apartment,
  onRestored,
  onNavigate,
}: {
  apartment: ApartmentSummary;
  onRestored: () => void;
  onNavigate: () => void;
}) {
  const archived = apartment.archivedRooms ?? [];
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const restore = useMutation({
    mutationFn: (roomId: string) => reactivateListing(roomId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({
        queryKey: ["inventory", "apartments-by-property"],
      });
      toast.success("Room restored as Draft. Publish it when you're ready.");
      onRestored();
    },
    onError: (err: Error) => toast.error(err.message || "Failed to restore room."),
    onSettled: () => setRestoringId(null),
  });

  if (archived.length === 0) return null;

  return (
    <div className="mt-6 rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Archived rooms ({archived.length})
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/80">
        Deactivated rooms keep their room type reserved, so you can&apos;t create a
        new room with the same name. Restore one to bring it back as a Draft.
      </p>
      <ul className="mt-2 space-y-1.5">
        {archived.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/40 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-sm font-medium capitalize text-foreground">
                {r.unitType}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {r.rentalRate == null ? "—" : `RM ${r.rentalRate}`}
              </span>
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                Archived
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={restore.isPending}
                onClick={() => {
                  setRestoringId(r.id);
                  restore.mutate(r.id);
                }}
              >
                {restoringId === r.id && restore.isPending ? "Restoring…" : "Restore"}
              </Button>
              <Link
                to={`/inventory/units/${r.id}`}
                onClick={onNavigate}
                className="rounded-md px-2 py-1 text-xs text-[var(--primary)] hover:underline"
              >
                View
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EditApartmentShell({
  trigger,
  unit,
}: {
  trigger: ReactNode;
  unit: UnitRowData;
}) {
  const [open, setOpen] = useState(false);
  // null = "follow the clicked unit" (also the reset value on close, so a
  // reopen from a DIFFERENT unit's row doesn't reuse the previous session's
  // tab selection).
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  // The "+ New Room" pseudo-tab is selected. Mutually exclusive with a room
  // tab: while adding, no EditUnitForm is mounted, so a half-typed new room
  // can never be confused for an edit of an existing one.
  const [adding, setAdding] = useState(false);

  // Step 1: the clicked unit's own detail — needed to learn its property +
  // unitCode so we can look up the apartment it belongs to. Same query this
  // shell's predecessor (EditUnitDialog) already issues; keyed identically so
  // EditUnitForm's own save-time invalidation (["inventory","unit",unitId,
  // "edit-form"]) matches whichever room ends up active.
  const clickedDetailQuery = useQuery({
    queryKey: ["inventory", "unit", unit.id, "edit-form"],
    queryFn: () => apiFetch<{ data: FetchedUnitDetail }>(`/inventory/units/${unit.id}`),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const clickedDetail = clickedDetailQuery.data?.data;
  const propertyName = clickedDetail?.property?.name ?? unit.propertyName;
  const propertyId = clickedDetail?.property?.id;

  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments-by-property", propertyId],
    queryFn: () => getApartmentsByProperty(propertyId as string),
    enabled: open && !!propertyId,
    staleTime: 30_000,
  });

  const apartment = useMemo(() => {
    if (!clickedDetail) return null;
    const code = clickedDetail.unitCode.trim().toLowerCase();
    return (
      (apartmentsQuery.data ?? []).find((a) => a.unitCode.trim().toLowerCase() === code) ?? null
    );
  }, [apartmentsQuery.data, clickedDetail]);

  // Every sibling room of this apartment (id + unitType + occupancy for the
  // tab header). Degrades to just the clicked unit if the apartment lookup
  // found no match (e.g. property lookup failed) — same degraded behaviour
  // EditUnitDialog already tolerates via apartment=null.
  const rooms: ApartmentRoomSummary[] = apartment?.rooms ?? [];

  const apartmentsReady = !clickedDetail
    ? false
    : !propertyId
      ? true
      : apartmentsQuery.isFetched;

  const queryClient = useQueryClient();

  // The active room: an explicit tab click wins; otherwise the clicked unit.
  const activeRoomId = selectedRoomId ?? unit.id;

  // Step 2: full detail of whichever room is ACTIVE. When activeRoomId equals
  // the clicked unit's id (the common case — no tab switch yet) this shares
  // the exact query-cache entry with clickedDetailQuery above, so switching
  // tabs is the only time a second network fetch actually fires.
  const activeDetailQuery = useQuery({
    queryKey: ["inventory", "unit", activeRoomId, "edit-form"],
    queryFn: () => apiFetch<{ data: FetchedUnitDetail }>(`/inventory/units/${activeRoomId}`),
    enabled: open && apartmentsReady,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const activeDetail = activeDetailQuery.data?.data;

  const loading =
    clickedDetailQuery.isLoading ||
    !clickedDetail ||
    !apartmentsReady ||
    activeDetailQuery.isLoading ||
    !activeDetail;

  const hasError = clickedDetailQuery.isError || activeDetailQuery.isError;

  // Only a PARTITIONED apartment takes more rooms. Adding a room to a WHOLE
  // apartment would make it MIXED — that is the Listing-mode flip's job, and
  // the flip control already lives inside each room's form.
  const canAddRoom =
    !!apartment && !!propertyId && apartment.listingMode === "PARTITIONED";

  // The header must render for a ONE-room apartment too, otherwise the only
  // affordance for adding a second room is invisible on exactly the apartment
  // that needs it most.
  const showTabs = rooms.length > 1 || canAddRoom;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setSelectedRoomId(null);
      setAdding(false);
    }
  }

  // Apartment-scoped sections. Built once here because they render in BOTH
  // branches below: handed to EditUnitForm as its trailingSlot (so the form's
  // sticky save bar stays the last element and keeps its pin — see the
  // trailingSlot prop docs), and rendered as plain siblings under AddRoomPanel,
  // which has no sticky bar to strand.
  const trailingSections = (
    <>
      {apartment && (
        <ArchivedRoomsSection
          apartment={apartment}
          onRestored={() => setAdding(false)}
          onNavigate={() => setOpen(false)}
        />
      )}

      {/* Carpark bays are apartment-scoped, not per-room, so they render
          ONCE below the room fields rather than inside the per-room form's
          own sections. Previously this section lived only in
          EditApartmentDialog; the apartment card now opens this shell instead,
          so without it here the bay editor would have no surface at all.
          Self-contained: owns its own fetch + mutations, and every internal
          button is type="button", so it never submits the room form. */}
      {apartment && propertyId && (
        <CarparksSection
          apartmentId={apartment.id}
          propertyId={propertyId}
          collapsible
        />
      )}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={trigger as React.ReactElement} />
      {/* max-w-4xl matches CreateUnitDialog — Edit and Create render the same
          UnitFormBody, so they must have the same width to lay out the same. */}
      {/* pt-0 (not p-6's top): the scroll container must have NO top padding,
          otherwise the sticky SectionNav in the per-room form locks 24px BELOW
          the modal's top edge, leaving a translucent band through which scrolled
          fields bleed — the "space bar". The header restores the breathing room
          with its own pt-6. See edit-unit-dialog.tsx for the same fix. */}
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto pt-0">
        <DialogHeader className="pt-6">
          <DialogTitle>
            Edit apartment · {propertyName} ·{" "}
            <span className="font-mono">{apartment?.unitCode ?? unit.unitCode}</span>
          </DialogTitle>
          <DialogDescription>
            {rooms.length > 1
              ? `This apartment has ${rooms.length} rooms. Pick a room below to edit it, or add another with + New Room. Owner and billing model apply to the whole apartment and are shown on every room.`
              : canAddRoom
                ? "This apartment has one room. Edit it below, or add another with + New Room."
                : "Revise unit attributes, lifecycle state, and visibility. Changes save together."}
          </DialogDescription>
        </DialogHeader>

        {hasError ? (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-400">
            Failed to load unit details. Close and reopen to retry.
          </div>
        ) : loading ? (
          <div className="space-y-4 py-8">
            <div className="h-32 bg-muted/40 rounded-xl animate-pulse" />
            <div className="h-48 bg-muted/40 rounded-xl animate-pulse" />
            <div className="h-24 bg-muted/40 rounded-xl animate-pulse" />
          </div>
        ) : (
          <>
            {showTabs && (
              <RoomTabHeader
                rooms={rooms}
                activeRoomId={activeRoomId}
                onSelect={(id) => {
                  setAdding(false);
                  setSelectedRoomId(id);
                }}
                canAddRoom={canAddRoom}
                adding={adding}
                onAddRoom={() => setAdding(true)}
              />
            )}
            {adding && apartment && propertyId ? (
              <div role="tabpanel" id="room-tabpanel-new">
                <AddRoomPanel
                  apartment={apartment}
                  propertyId={propertyId}
                  onCreated={(roomId) => {
                    setAdding(false);
                    // Land on the room we just made, so its per-room form is
                    // right there for any follow-up edit.
                    if (roomId) setSelectedRoomId(roomId);
                  }}
                  onCancel={() => setAdding(false)}
                />
                {trailingSections}
              </div>
            ) : (
              <div
                role="tabpanel"
                id={`room-tabpanel-${activeRoomId}`}
                aria-labelledby={showTabs ? `room-tab-${activeRoomId}` : undefined}
              >
                {/* key=activeRoomId forces a clean remount on tab switch — a
                    fresh EditUnitForm instance re-seeds its form state (and its
                    initialForm dirty-baseline) from the newly active room's own
                    detail, exactly like closing and reopening EditUnitDialog on
                    a different unit. Each room's save is therefore fully
                    independent: editing room 1 then room 2 fires two separate
                    PUT /inventory/units/:id calls, each carrying every existing
                    guard (partial-write, LISTING_MODE_MISMATCH, sibling-type
                    conflict, owner-wipe, R6 owner confirm) unmodified. */}
                <EditUnitForm
                  key={activeRoomId}
                  detail={activeDetail}
                  unitId={activeRoomId}
                  propertyName={propertyName}
                  apartment={apartment}
                  onClose={() => setOpen(false)}
                  onSaved={() => {
                    // A room saved: KEEP the apartment dialog open (do NOT close)
                    // so the admin can move on to the next room. EditUnitForm's own
                    // onSuccess already invalidated this room's detail + the
                    // ["inventory"] tree; we additionally refresh the apartment
                    // roster so the tab labels reflect any room-type change.
                    queryClient.invalidateQueries({
                      queryKey: ["inventory", "apartments-by-property"],
                    });
                  }}
                  trailingSlot={trailingSections}
                />
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
