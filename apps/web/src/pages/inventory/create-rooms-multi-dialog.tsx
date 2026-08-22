// Admin equivalent of the portal multi-room form. Same shape (Apartment
// shared fields + N rooms with per-room rent/deposit/parking + "Same as
// Room 1" inheritance) but mounted as a Dialog and calls the admin batch
// endpoint /api/inventory/units/batch.
//
// Kept as a sibling to CreateUnitDialog (single-unit, with full admin-only
// fields like visibilityMode + grants). Admins pick the right entry point
// from PropertyRow.
//
// Phase C (2026-05-13 apartment-aggregation spec): adds a unit-code
// typeahead. When admin picks an existing apartment, the shared block is
// pre-filled, existing rooms render as read-only context, and any edit to
// the shared block triggers a fan-out confirmation that opts into
// applyToExistingSiblings=true on the batch endpoint.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Lock, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { DepositFields } from "@/components/deposit-fields";
import { ParkingFields } from "@/components/parking-fields";
import { AmenityCombobox } from "@/components/amenity-combobox";
import { TagInput } from "@/components/tag-input";
import { useActiveAmenities } from "@/hooks/use-amenities";
import { apiFetch } from "@/lib/api-client";
import {
  createUnitsBatch,
  getApartmentsByProperty,
  type ApartmentSummary,
  type CreateUnitsBatchRoom,
} from "@/api/inventory-units-batch";

type AdminRoomType = { id: string; name: string; sortOrder: number };

const emptyRoom = (): CreateUnitsBatchRoom => ({
  unitType: "",
  rentalRate: undefined,
  depositMonths: undefined,
  utilitiesDepositMonths: undefined,
  accessCardDepositPerPcs: undefined,
  accessCardQuantity: undefined,
  parkingQuantity: undefined,
  parkingNumbers: [],
});

type SharedState = {
  unitCode: string;
  floor?: number;
  bedrooms?: number;
  bathrooms?: number;
  floorArea?: number;
  // Apartment-scoped (matches batch endpoint's shared block): catalog
  // amenities AND free-form highlights. Both fan out to every room
  // created in one batch.
  amenities: string[];
  highlights: string[];
  description?: string | null;
};

const emptyShared: SharedState = {
  unitCode: "",
  floor: undefined,
  bedrooms: undefined,
  bathrooms: undefined,
  floorArea: undefined,
  amenities: [],
  highlights: [],
  description: null,
};

// Apartment-scoped delta detector for the SharedState shape. Mirrors the
// rules of `apartmentScopedChangedFields` in edit-unit-dialog.tsx (which
// operates on UnitFormState — different storage shape, same semantics):
//   - Scalars: empty-string ↔ null/undefined is NOT a change; otherwise
//     strict equality.
//   - description: trim both sides; null/undefined and "" after trim are
//     equivalent.
//   - amenities, highlights: set semantics — sort then compare. Reorder is
//     NOT a change.
// Canonical helper: apps/web/src/pages/inventory/edit-unit-dialog.tsx →
// `apartmentScopedChangedFields(initial, current)`.
export function sharedApartmentScopedChangedFields(
  initial: SharedState,
  current: SharedState,
): string[] {
  const changed: string[] = [];
  const scalarFields: Array<"bedrooms" | "bathrooms" | "floor" | "floorArea"> = [
    "bedrooms",
    "bathrooms",
    "floor",
    "floorArea",
  ];
  for (const f of scalarFields) {
    const a = initial[f] ?? null;
    const b = current[f] ?? null;
    if (a !== b) changed.push(f);
  }
  const aDesc = (initial.description ?? "").trim();
  const bDesc = (current.description ?? "").trim();
  if (aDesc !== bDesc) changed.push("description");
  const setEq = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sortA = [...a].sort();
    const sortB = [...b].sort();
    return sortA.every((v, i) => v === sortB[i]);
  };
  if (!setEq(initial.amenities, current.amenities)) changed.push("amenities");
  if (!setEq(initial.highlights, current.highlights)) changed.push("highlights");
  return changed;
}

// Map an ApartmentSummary into the SharedState shape used by this dialog.
// The summary's `amenities` is `{id, name}[]`; SharedState carries just
// the IDs (the batch endpoint expects catalog UUIDs).
export function apartmentToSharedState(apt: ApartmentSummary): SharedState {
  return {
    unitCode: apt.unitCode,
    floor: apt.floor ?? undefined,
    bedrooms: apt.bedrooms ?? undefined,
    bathrooms: apt.bathrooms ?? undefined,
    floorArea: apt.floorArea ?? undefined,
    amenities: apt.amenities.map((a) => a.id),
    highlights: apt.highlights ?? [],
    description: apt.description ?? null,
  };
}

export function CreateRoomsMultiDialog({
  trigger,
  propertyId,
  propertyName,
  existingApartments,
  defaultMatchedApartment,
}: {
  trigger: ReactNode;
  propertyId: string;
  propertyName: string;
  // Optional — parent (property-row / property-page) can pre-load the
  // grouped view to avoid a fresh fetch. When absent, the dialog fetches
  // on open.
  existingApartments?: ApartmentSummary[];
  // Optional — when the parent already knows which apartment the admin
  // wants to add rooms to (e.g. clicking `[+ Add rooms]` on an apartment
  // card), pre-bind the dialog to that apartment so typeahead is
  // unnecessary and shared fields are pre-filled.
  defaultMatchedApartment?: ApartmentSummary;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  // Org-curated amenity catalog. Apartment-level — every room created in
  // this batch shares the picks.
  const amenitiesQuery = useActiveAmenities();

  const [shared, setShared] = useState<SharedState>(emptyShared);
  const [rooms, setRooms] = useState<CreateUnitsBatchRoom[]>([emptyRoom()]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [sameAsRoom1, setSameAsRoom1] = useState<Record<number, boolean>>({});

  // Phase C — typeahead state.
  // matchedApartment: the apartment the admin selected from the typeahead,
  //   or null when typing a brand-new unit code. When set, the shared block
  //   is pre-filled from this and existing rooms render as read-only
  //   context. `initialSharedSnapshot` is the SharedState at the time of
  //   the match — used to detect apartment-scoped deltas on submit.
  const [matchedApartment, setMatchedApartment] =
    useState<ApartmentSummary | null>(null);
  const initialSharedSnapshot = useRef<SharedState | null>(null);
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [confirmFanOut, setConfirmFanOut] = useState<string[] | null>(null);

  // Source of truth for the typeahead: prop-provided list, or fetch on open.
  // The query is enabled only when the dialog is open AND the prop wasn't
  // passed — avoids burning a request on every property-row render.
  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments", "by-property", propertyId],
    queryFn: () => getApartmentsByProperty(propertyId),
    enabled: open && existingApartments === undefined,
    staleTime: 30_000,
  });
  const apartments: ApartmentSummary[] =
    existingApartments ?? apartmentsQuery.data ?? [];

  // Admin endpoint — must NOT use the portal `useRoomTypes` hook here.
  // PortalApiFetch hard-redirects to /portal/login on 401, which kicks
  // admins to the agent login screen the moment /inventory mounts.
  const roomTypesQuery = useQuery({
    queryKey: ["inventory-units-batch", "room-types"],
    queryFn: () =>
      apiFetch<{ data: AdminRoomType[] }>("/commissions/room-types?activeOnly=true"),
    staleTime: 60_000,
  });
  const unitTypeOptions = (roomTypesQuery.data?.data ?? [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({ value: r.name, label: r.name }));

  // Filter the typeahead suggestion list by what the admin has typed
  // (case-insensitive, trimmed prefix-or-substring match).
  const typeaheadSuggestions = useMemo(() => {
    const q = shared.unitCode.trim().toLowerCase();
    if (!q) return apartments;
    return apartments.filter((apt) =>
      apt.unitCode.toLowerCase().includes(q),
    );
  }, [apartments, shared.unitCode]);

  function resetAndClose() {
    setShared(emptyShared);
    setRooms([emptyRoom()]);
    setExpanded({});
    setSameAsRoom1({});
    setMatchedApartment(null);
    initialSharedSnapshot.current = null;
    setTypeaheadOpen(false);
    setConfirmFanOut(null);
    setOpen(false);
  }

  // Whenever the dialog closes via the Dialog primitive (Escape, outside
  // click, or programmatic close), wipe typeahead/match state too. The
  // Cancel button calls resetAndClose() directly; this covers everything
  // else.
  //
  // When `defaultMatchedApartment` is supplied (entry from an apartment
  // card's `[+ Add rooms]` button), pre-pick that apartment on open so the
  // shared block is pre-filled and existing rooms render as read-only
  // context without the admin having to use the typeahead.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setShared(emptyShared);
      setRooms([emptyRoom()]);
      setExpanded({});
      setSameAsRoom1({});
      setMatchedApartment(null);
      initialSharedSnapshot.current = null;
      setTypeaheadOpen(false);
      setConfirmFanOut(null);
    } else if (defaultMatchedApartment) {
      const next = apartmentToSharedState(defaultMatchedApartment);
      setShared(next);
      setMatchedApartment(defaultMatchedApartment);
      initialSharedSnapshot.current = next;
    }
  }, [open, defaultMatchedApartment]);

  function pickApartment(apt: ApartmentSummary) {
    // Spec case-folding rule: typeahead matches case-insensitively, but the
    // stored value is the existing apartment's canonical `unitCode` — never
    // the admin's typed casing. Prevents silently creating a third casing.
    const next = apartmentToSharedState(apt);
    setShared(next);
    setMatchedApartment(apt);
    initialSharedSnapshot.current = next;
    setTypeaheadOpen(false);
  }

  function clearMatch() {
    setMatchedApartment(null);
    initialSharedSnapshot.current = null;
  }

  function onUnitCodeChange(value: string) {
    setShared((prev) => ({ ...prev, unitCode: value }));
    // Typing after a match invalidates the match — admin is editing the
    // code itself, not the matched apartment's shared fields.
    if (matchedApartment && value.trim().toLowerCase() !== matchedApartment.unitCode.toLowerCase()) {
      clearMatch();
    }
    setTypeaheadOpen(true);
  }

  // Reject any new room whose unitType already exists on a sibling of the
  // matched apartment. Independent of the within-batch duplicate check
  // below.
  const existingSiblingTypes = useMemo(() => {
    if (!matchedApartment) return new Set<string>();
    return new Set(matchedApartment.rooms.map((r) => r.unitType.trim()));
  }, [matchedApartment]);

  // Duplicate detection:
  //   1) duplicateUnitType — same unitType appears twice in the new-rooms
  //      list being added in this batch (within-batch).
  //   2) collidingExistingType — a new room's unitType matches an existing
  //      sibling of the matched apartment (cross-batch). Only fires when a
  //      typeahead match has been selected.
  const duplicateUnitType = (() => {
    const seen = new Set<string>();
    for (const r of rooms) {
      const t = r.unitType.trim();
      if (!t) continue;
      if (seen.has(t)) return t;
      seen.add(t);
    }
    return null;
  })();
  const collidingExistingType = useMemo(() => {
    if (!matchedApartment) return null;
    for (const r of rooms) {
      const t = r.unitType.trim();
      if (!t) continue;
      if (existingSiblingTypes.has(t)) return t;
    }
    return null;
  }, [rooms, matchedApartment, existingSiblingTypes]);

  // Whether the shared block has any apartment-scoped diff vs the snapshot
  // captured when the match was selected. Empty array ⇒ pure additive.
  const apartmentChanged = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
    if (!matchedApartment || !initialSharedSnapshot.current) return [];
    return sharedApartmentScopedChangedFields(
      // eslint-disable-next-line react-hooks/refs -- deliberate: ref is a render-time baseline/mirror (dirty-check or latest-value), read during render on purpose
      initialSharedSnapshot.current,
      shared,
    );
  }, [matchedApartment, shared]);

  // Each room must have a unitType AND both deposit-months fields populated.
  // Rooms past the first inherit deposits from Room 1 when `sameAsRoom1[i]`
  // is true — in that case the room's own deposit fields are hidden and the
  // values come from Room 1 at materialization time. Room 1 itself must
  // always declare its own deposits.
  const roomsValid =
    rooms.length === 0 ||
    rooms.every((r, i) => {
      if (r.unitType.trim() === "") return false;
      const inheritsFromRoom1 = i > 0 && sameAsRoom1[i];
      if (inheritsFromRoom1) return true;
      return r.depositMonths !== undefined && r.utilitiesDepositMonths !== undefined;
    });

  // Empty rooms is valid only when a match is selected AND admin actually
  // changed an apartment-scoped field — the call then becomes an
  // apartment-only update (rooms: [], applyToExistingSiblings: true).
  const emptyRoomsAllowed =
    matchedApartment !== null &&
    rooms.length === 0 &&
    apartmentChanged.length > 0;

  const canSubmit =
    shared.unitCode.trim() !== "" &&
    (rooms.length > 0 || emptyRoomsAllowed) &&
    roomsValid &&
    duplicateUnitType === null &&
    collidingExistingType === null;

  function patchRoom(index: number, patch: Partial<CreateUnitsBatchRoom>) {
    setRooms((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  function addRoom() {
    setRooms((prev) => [...prev, emptyRoom()]);
  }

  function removeRoom(index: number) {
    setRooms((prev) => prev.filter((_, i) => i !== index));
    const reindex = (prev: Record<number, boolean>) => {
      const next: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        const ki = Number(k);
        if (ki < index) next[ki] = v;
        else if (ki > index) next[ki - 1] = v;
      }
      return next;
    };
    setExpanded(reindex);
    setSameAsRoom1(reindex);
  }

  const create = useMutation({
    mutationFn: (args: { applyToExistingSiblings: boolean }) => {
      const room1 = rooms[0];
      const materializedRooms: CreateUnitsBatchRoom[] = rooms.map((r, i) =>
        i > 0 && sameAsRoom1[i] && room1
          ? {
              ...r,
              depositMonths: room1.depositMonths,
              utilitiesDepositMonths: room1.utilitiesDepositMonths,
              accessCardDepositPerPcs: room1.accessCardDepositPerPcs,
              accessCardQuantity: room1.accessCardQuantity,
              parkingQuantity: room1.parkingQuantity,
              parkingNumbers: room1.parkingNumbers,
            }
          : r,
      );
      return createUnitsBatch({
        shared: { ...shared, propertyId },
        rooms: materializedRooms,
        applyToExistingSiblings: args.applyToExistingSiblings,
      });
    },
    onSuccess: (data) => {
      const newCount = data.ids.length;
      const updatedCount = data.updatedIds?.length ?? 0;
      if (newCount === 0 && updatedCount > 0) {
        toast.success(
          updatedCount === 1
            ? "Apartment details updated."
            : `Apartment details updated on ${updatedCount} rooms.`,
        );
      } else {
        toast.success(
          newCount === 1
            ? "Room created."
            : `${newCount} rooms created.`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      resetAndClose();
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create rooms"),
  });

  function submitWithFlag(applyToExistingSiblings: boolean) {
    create.mutate({ applyToExistingSiblings });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || create.isPending) return;
    // Match selected + shared changed → confirmation modal.
    if (matchedApartment && apartmentChanged.length > 0) {
      setConfirmFanOut(apartmentChanged);
      return;
    }
    // Pure additive path (no match, or match with no shared change).
    submitWithFlag(false);
  }

  // Footer button copy:
  //   - rooms === 0 (only valid when match + shared change) → "Update apartment details"
  //   - rooms === 1 → "Create room"
  //   - rooms > 1   → "Create N rooms"
  const submitLabel = (() => {
    if (create.isPending) return "Saving…";
    if (rooms.length === 0) return "Update apartment details";
    if (rooms.length === 1) return "Create room";
    return `Create ${rooms.length} rooms`;
  })();

  // List of existing room types that will receive the fan-out update —
  // surfaced in the ConfirmAlert body so admin can see what they're about
  // to overwrite.
  const existingRoomTypeList = matchedApartment
    ? matchedApartment.rooms.map((r) => r.unitType).join(", ")
    : "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add rooms · {propertyName}</DialogTitle>
          <DialogDescription>
            Create one or more rooms under the same apartment. Each row
            becomes its own Unit, sharing the apartment metadata but with
            its own rent + deposit + parking. All units are created
            atomically.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5">
          {/* SHARED — apartment-level metadata */}
          <fieldset className="space-y-4 rounded-md border border-border p-4">
            <legend className="px-2 text-sm font-medium">Apartment details</legend>

            {matchedApartment?.hasDrift && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  This apartment's existing rooms disagree on shared
                  fields. Values shown are from the earliest-created room.
                  Saving with fan-out will overwrite the drift.
                </span>
              </div>
            )}

            {/* Apartment code row — branches on defaultMatchedApartment */}
            {defaultMatchedApartment ? (
              <div className="block">
                <span className="text-xs text-muted-foreground">Apartment</span>
                <div className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm font-mono text-foreground">
                  <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                  {shared.unitCode}
                </div>
                <p className="text-[11px] text-muted-foreground/80 mt-1">
                  Adding rooms to this apartment. To target a different apartment,
                  close and use the property&apos;s +Rooms button.
                </p>
              </div>
            ) : (
              <label className="block relative">
                <span className="text-xs text-muted-foreground">Unit code *</span>
                <Input
                  value={shared.unitCode}
                  onChange={(e) => onUnitCodeChange(e.target.value)}
                  onFocus={() => setTypeaheadOpen(true)}
                  onBlur={() => {
                    // Defer close so onMouseDown on a suggestion can fire
                    // before the list unmounts.
                    setTimeout(() => setTypeaheadOpen(false), 120);
                  }}
                  placeholder="e.g. B-08-08"
                  autoComplete="off"
                  required
                  aria-autocomplete="list"
                  aria-expanded={typeaheadOpen}
                />
                {typeaheadOpen && typeaheadSuggestions.length > 0 && (
                  <ul
                    role="listbox"
                    aria-label="Existing apartments"
                    className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md"
                  >
                    {typeaheadSuggestions.map((apt) => (
                      <li
                        key={apt.unitCode}
                        role="option"
                        aria-selected={
                          matchedApartment?.unitCode === apt.unitCode
                        }
                        tabIndex={-1}
                        // onMouseDown beats the input's onBlur — keeps the
                        // deferred close from cancelling the pick. onClick
                        // is the fallback for keyboard / RTL test events
                        // that don't propagate mousedown to the option.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pickApartment(apt);
                        }}
                        onClick={() => pickApartment(apt)}
                        className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left hover:bg-muted/60"
                      >
                        <span className="font-mono">{apt.unitCode}</span>
                        <span className="text-xs text-muted-foreground">
                          {apt.rooms.length} room
                          {apt.rooms.length === 1 ? "" : "s"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </label>
            )}

            {/* Numeric grid — Floor moved into here so locked mode displays cleanly */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
              <label className="block">
                <span className="text-xs text-muted-foreground">Floor</span>
                <Input
                  type="number"
                  value={shared.floor ?? ""}
                  onChange={(e) =>
                    setShared({
                      ...shared,
                      floor: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">
                  Bedrooms
                </span>
                <Input
                  type="number"
                  min={0}
                  value={shared.bedrooms ?? ""}
                  onChange={(e) =>
                    setShared({
                      ...shared,
                      bedrooms: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">
                  Bathrooms
                </span>
                <Input
                  type="number"
                  min={0}
                  value={shared.bathrooms ?? ""}
                  onChange={(e) =>
                    setShared({
                      ...shared,
                      bathrooms: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">
                  Floor area (sqft)
                </span>
                <Input
                  type="number"
                  min={0}
                  value={shared.floorArea ?? ""}
                  onChange={(e) =>
                    setShared({
                      ...shared,
                      floorArea: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </label>
            </div>

            {/* Amenities — apartment-level (org-curated catalog). Wrapped
                in <div> not <label> so chip-remove clicks don't bubble to
                an auto-activating label. Same pattern as the portal page. */}
            <div className="block">
              <span className="text-xs text-muted-foreground">
                Amenities (apartment)
              </span>
              <div className="mt-1">
                <AmenityCombobox
                  value={shared.amenities}
                  onChange={(amenities) => setShared({ ...shared, amenities })}
                  catalog={amenitiesQuery.data ?? []}
                  disabled={amenitiesQuery.isLoading}
                />
              </div>
            </div>

            {/* Highlights — apartment-level free-form selling points.
                Distinct from Amenities: not catalog-bound, not a filter
                facet — visible on listing cards + full-text search. */}
            <div className="block">
              <span className="text-xs text-muted-foreground">
                Highlights (apartment)
              </span>
              <p className="text-[11px] text-muted-foreground/80 mb-1">
                Free-form selling points specific to this apartment — “Near
                KLCC”, “Corner unit”, “Renovated 2025”. Comma or Enter to
                add. For standardized features like Pool or Gym, use
                Amenities above.
              </p>
              <TagInput
                values={shared.highlights}
                onChange={(highlights) => setShared({ ...shared, highlights })}
                placeholder="Near KLCC, Corner unit…"
              />
            </div>
          </fieldset>

          {/* EXISTING ROOMS — read-only context when a match is selected */}
          {matchedApartment && matchedApartment.rooms.length > 0 && (
            <fieldset className="space-y-2 rounded-md border border-dashed border-border bg-muted/20 p-4">
              <legend className="px-2 text-sm font-medium text-muted-foreground">
                Existing rooms in this apartment
              </legend>
              <ul className="space-y-1.5">
                {matchedApartment.rooms.map((r) => {
                  const status = r.occupancyStatus ?? r.listingStatus;
                  return (
                    <li
                      key={r.id}
                      className="flex items-center justify-between rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">{r.unitType}</span>
                      <span>
                        RM {r.rentalRate ?? "—"} · <span className="capitalize">{status}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}

          {/* ROOMS */}
          <fieldset className="space-y-4 rounded-md border border-border p-4">
            <legend className="px-2 text-sm font-medium">Rooms</legend>
            {rooms.map((room, index) => {
              const isOpen = expanded[index] === true;
              const reuse = index > 0 && sameAsRoom1[index] === true;
              const room1 = rooms[0];
              return (
                <div
                  key={index}
                  className="rounded-lg border border-border bg-background/40 p-4 space-y-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid flex-1 gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-xs text-muted-foreground">
                          Room type *
                        </span>
                        <select
                          value={room.unitType}
                          onChange={(e) =>
                            patchRoom(index, { unitType: e.target.value })
                          }
                          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          disabled={roomTypesQuery.isLoading}
                          required
                        >
                          <option value="">
                            {roomTypesQuery.isLoading
                              ? "Loading…"
                              : unitTypeOptions.length === 0
                                ? "No unit types configured"
                                : "Pick a room type…"}
                          </option>
                          {unitTypeOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs text-muted-foreground">
                          Rent (RM/month)
                        </span>
                        <Input
                          type="number"
                          min={0}
                          value={room.rentalRate ?? ""}
                          onChange={(e) =>
                            patchRoom(index, {
                              rentalRate: e.target.value
                                ? Number(e.target.value)
                                : undefined,
                            })
                          }
                        />
                      </label>
                    </div>
                    {/* Allow removing the last room only when an apartment
                        is matched — empty rooms is a valid apartment-only
                        edit in that case (spec §"Empty rooms = apartment-
                        only edit"). Without a match, keep the existing
                        guarantee that the form always has at least one
                        row. */}
                    {(rooms.length > 1 || matchedApartment !== null) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeRoom(index)}
                        aria-label={`Remove room ${index + 1}`}
                        title="Remove room"
                        className="shrink-0 mt-5 text-rose-600 hover:text-rose-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                  {index > 0 && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={reuse}
                        onChange={(e) =>
                          setSameAsRoom1((prev) => ({
                            ...prev,
                            [index]: e.target.checked,
                          }))
                        }
                        className="h-4 w-4 rounded border-input"
                      />
                      Use Room 1's deposits + parking
                    </label>
                  )}

                  {!reuse && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [index]: !isOpen }))
                      }
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                      {isOpen ? "Hide" : "Show"} deposits + parking for this
                      room
                    </button>
                  )}

                  {reuse && room1 && (
                    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                      <div className="font-medium text-foreground">
                        Inheriting from Room 1
                      </div>
                      <div>
                        Rental deposit:{" "}
                        {room1.depositMonths == null
                          ? "—"
                          : `${room1.depositMonths} ${room1.depositMonths > 1 ? "months" : "month"}`} · Utilities:{" "}
                        {room1.utilitiesDepositMonths == null
                          ? "—"
                          : `${room1.utilitiesDepositMonths} ${room1.utilitiesDepositMonths > 1 ? "months" : "month"}`} ·
                        Access cards: {room1.accessCardQuantity ?? 0} pc(s)
                      </div>
                      <div>
                        Parking: {room1.parkingQuantity ?? 0} spot(s)
                        {room1.parkingNumbers &&
                        room1.parkingNumbers.length > 0
                          ? ` (${room1.parkingNumbers.join(", ")})`
                          : ""}
                      </div>
                    </div>
                  )}

                  {!reuse && isOpen && (
                    <div className="space-y-3 pt-2 border-t border-border">
                      <DepositFields
                        rentalRate={room.rentalRate ?? null}
                        depositMonths={room.depositMonths ?? null}
                        utilitiesDepositMonths={
                          room.utilitiesDepositMonths ?? null
                        }
                        accessCardDepositPerPcs={
                          room.accessCardDepositPerPcs ?? null
                        }
                        accessCardQuantity={room.accessCardQuantity ?? null}
                        onChange={(patch) =>
                          patchRoom(index, {
                            ...(patch.depositMonths !== undefined && {
                              depositMonths: patch.depositMonths ?? undefined,
                            }),
                            ...(patch.utilitiesDepositMonths !== undefined && {
                              utilitiesDepositMonths:
                                patch.utilitiesDepositMonths ?? undefined,
                            }),
                            ...(patch.accessCardDepositPerPcs !== undefined && {
                              accessCardDepositPerPcs:
                                patch.accessCardDepositPerPcs ?? undefined,
                            }),
                            ...(patch.accessCardQuantity !== undefined && {
                              accessCardQuantity:
                                patch.accessCardQuantity ?? undefined,
                            }),
                          })
                        }
                      />
                      <ParkingFields
                        parkingQuantity={room.parkingQuantity ?? null}
                        parkingNumbers={room.parkingNumbers ?? []}
                        onChange={(patch) =>
                          patchRoom(index, {
                            parkingQuantity: patch.parkingQuantity ?? undefined,
                            parkingNumbers: patch.parkingNumbers,
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              onClick={addRoom}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-1" /> Add another room
            </Button>
            {duplicateUnitType && (
              <p className="text-xs text-rose-600">
                Duplicate room type "{duplicateUnitType}". Pick a different
                type or remove the duplicate row.
              </p>
            )}
            {collidingExistingType && (
              <p className="text-xs text-rose-600">
                Room type "{collidingExistingType}" already exists in this
                apartment. Pick a different type.
              </p>
            )}
          </fieldset>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={resetAndClose}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || create.isPending}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>

        <ConfirmAlert
          open={confirmFanOut !== null}
          onCancel={() => setConfirmFanOut(null)}
          onConfirm={() => {
            setConfirmFanOut(null);
            submitWithFlag(true);
          }}
          title="Update apartment-level fields?"
          body={
            <span>
              You changed{" "}
              <strong>{confirmFanOut?.join(", ") ?? ""}</strong>. These
              fields apply to the whole apartment, so the change will also
              be saved to every existing room in this apartment
              {existingRoomTypeList ? (
                <>
                  {" "}
                  (<strong>{existingRoomTypeList}</strong>)
                </>
              ) : null}
              .
            </span>
          }
          confirmLabel={
            rooms.length === 0
              ? "Update apartment details"
              : "Update apartment + add rooms"
          }
        />
      </DialogContent>
    </Dialog>
  );
}
