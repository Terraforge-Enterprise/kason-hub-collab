// Portal page — agent creates rental Unit(s). Supports the common Malaysian
// sub-let pattern where one apartment is listed as multiple rooms
// (Master / Medium / Single), each its own Unit row sharing propertyId +
// unitCode but differing on unitType. Submission goes to the source queue;
// server forces sourceFlag=AGENT_SOURCED, sourcingApproved=false,
// inChargePartyId=session.partyId per the unified-property-sourcing spec.
//
// 2026-05-13 apartment-aggregation Phase C: when the agent picks an existing
// apartment via typeahead, shared fields are pre-filled from the canonical
// sibling, existing rooms render as read-only context, and the shared block
// is gated by ownership — only the original sourcing agent (and only when
// they own every existing sibling) can fan out apartment-scoped edits.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  ChevronDown,
  Lock,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { CreatePropertyDialog } from "@/components/portal/create-property-dialog";
import { DepositFields } from "@/components/deposit-fields";
import { ParkingFields } from "@/components/parking-fields";
import { AmenityCombobox } from "@/components/amenity-combobox";
import { TagInput } from "@/components/tag-input";
import { usePortalAmenities } from "@/hooks/use-portal-amenities";
import { useRoomTypes } from "@/hooks/use-room-types";
import { usePortalSession } from "@/api/portal-auth";
import {
  createPortalUnitsBatch,
  listPortalProperties,
  portalGetApartmentsByProperty,
  type CreatePortalUnitsBatchPayload,
  type CreatePortalUnitsBatchRoom,
  type CreatePortalUnitsBatchSharedFields,
  type PortalApartmentSummary,
} from "@/api/portal-inventory";
import { occupancyLabel, listingLabel } from "@/lib/listing-status";

// Empty per-room template. unitType starts blank so canSubmit forces a
// pick; the rest are optional. parkingNumbers stays [] so ParkingFields
// doesn't crash on undefined.
const emptyRoom = (): CreatePortalUnitsBatchRoom => ({
  unitType: "",
  rentalRate: undefined,
  depositMonths: undefined,
  utilitiesDepositMonths: undefined,
  accessCardDepositPerPcs: undefined,
  accessCardQuantity: undefined,
  parkingQuantity: undefined,
  parkingNumbers: [],
});

/**
 * Parse a numeric form field as a non-negative integer-ish.
 * Returns `undefined` on empty / non-numeric / negative input — properties
 * never have negative floor count, area, bedrooms, bathrooms, or rent.
 * Used by the shared and per-room number inputs in this form.
 */
function parseNonNegative(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

// Apartment-scoped delta detection — same rules as the admin EditUnitDialog
// helper (see `apartmentScopedChangedFields` in edit-unit-dialog.tsx). Kept
// inline rather than imported because that module's helper takes a
// `UnitFormState` (admin form shape) and we operate on
// `CreatePortalUnitsBatchSharedFields` (portal batch shape). Same comparison
// rules verbatim:
//   - Scalars (bedrooms/bathrooms/floor/floorArea): strict equality after
//     coercing empty/undefined ↔ null. `undefined` ↔ `null` is NOT a change.
//   - description: trim both sides; null ↔ "" after trim is NOT a change.
//   - amenities, highlights: set semantics — sort then compare. Reorder
//     is NOT a change. Add/remove IS.
export function sharedScopedChangedFields(
  initial: CreatePortalUnitsBatchSharedFields,
  current: CreatePortalUnitsBatchSharedFields,
): string[] {
  const changed: string[] = [];
  const scalarFields = ["bedrooms", "bathrooms", "floor", "floorArea"] as const;
  for (const f of scalarFields) {
    const a = initial[f] ?? null;
    const b = current[f] ?? null;
    if (a !== b) changed.push(f);
  }
  if ((initial.description ?? "").trim() !== (current.description ?? "").trim()) {
    changed.push("description");
  }
  const setEq = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sortA = [...a].sort();
    const sortB = [...b].sort();
    return sortA.every((v, i) => v === sortB[i]);
  };
  if (!setEq(initial.amenities ?? [], current.amenities ?? [])) changed.push("amenities");
  if (!setEq(initial.highlights ?? [], current.highlights ?? [])) changed.push("highlights");
  return changed;
}

// Convert an apartment summary's canonical apartment-scoped values into the
// shape the shared-state setter expects. Amenities arrive as catalog rows
// ({id, name}) on the wire; the form state stores IDs only.
export function apartmentSummaryToShared(
  apt: PortalApartmentSummary,
  propertyId: string,
): CreatePortalUnitsBatchSharedFields {
  return {
    propertyId,
    unitCode: apt.unitCode,
    floor: apt.floor ?? undefined,
    bedrooms: apt.bedrooms ?? undefined,
    bathrooms: apt.bathrooms ?? undefined,
    floorArea: apt.floorArea ?? undefined,
    amenities: apt.amenities.map((a) => a.id),
    highlights: apt.highlights ?? [],
    description: apt.description,
  };
}

// Case-insensitive + trim match. Returns the matched apartment, or null.
export function findApartmentByCode(
  apartments: PortalApartmentSummary[],
  typed: string,
): PortalApartmentSummary | null {
  const needle = typed.trim().toLowerCase();
  if (!needle) return null;
  return (
    apartments.find((a) => a.unitCode.trim().toLowerCase() === needle) ?? null
  );
}

export default function PortalInventoryCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [propertyDialogOpen, setPropertyDialogOpen] = useState(false);

  const sessionQuery = usePortalSession();
  const myPartyId = sessionQuery.data?.partyId ?? null;

  const [shared, setShared] = useState<CreatePortalUnitsBatchSharedFields>({
    propertyId: "",
    unitCode: "",
    floor: undefined,
    bedrooms: undefined,
    bathrooms: undefined,
    floorArea: undefined,
    amenities: [],
    highlights: [],
    description: null,
  });

  const [rooms, setRooms] = useState<CreatePortalUnitsBatchRoom[]>([
    emptyRoom(),
  ]);

  // Per-room expand state for the "More options" (deposit + parking)
  // section. Keyed by array index; we reset it when rooms array shrinks.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // Per-room flag: "use Room 1's deposits + parking". UI-only — at submit
  // we copy Room 1's values into the room before serializing. Disabled on
  // Room 1 itself. Index 0 is never used (Room 1 = sourceOfTruth).
  const [sameAsRoom1, setSameAsRoom1] = useState<Record<number, boolean>>({});

  // Apartment typeahead state. `unitCodeDraft` mirrors what the user typed;
  // we keep it separate from `shared.unitCode` because when a match is
  // selected, `shared.unitCode` snaps to the apartment's canonical casing
  // (spec §"unit-code is NOT case-folded at storage") while the draft can
  // still reflect what was last typed for the dropdown filter.
  const [unitCodeDraft, setUnitCodeDraft] = useState("");
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  // Match state: the picked apartment + a snapshot of `shared` taken at the
  // moment of the pick. The snapshot drives apartment-scoped delta detection
  // at submit time. Kept as a single `useState` so the snapshot updates
  // synchronously with the match (avoids the ref-during-render lint).
  const [match, setMatch] = useState<{
    apartment: PortalApartmentSummary;
    initialShared: CreatePortalUnitsBatchSharedFields;
  } | null>(null);
  const matchedApartment = match?.apartment ?? null;
  // Pending fan-out confirmation. List of changed field names; null = no
  // prompt pending. Mirrors EditUnitDialog's pattern.
  const [confirmFanOut, setConfirmFanOut] = useState<string[] | null>(null);

  const propsQuery = useQuery({
    queryKey: ["portal-properties"],
    queryFn: listPortalProperties,
  });

  // Unit-type options sourced from the org's RoomType table (admin
  // configures these under /commissions/settings → Room Types). Same
  // source as the admin create-unit dialog.
  const roomTypesQuery = useRoomTypes();
  // When an existing apartment is matched, filter room types to ones that
  // match its listingMode (WHOLE-mode apartment accepts only WHOLE-kind
  // room types; PARTITIONED accepts only PARTITION-kind). Without this gate
  // the agent could pick a "Master" under a Whole Unit apartment and only
  // discover the LISTING_MODE_MISMATCH after Submit — backend rule stays as
  // defense-in-depth. MIXED / null = legacy state, no filter.
  const roomTypeFilterKind = useMemo<"WHOLE" | "PARTITION" | null>(() => {
    if (!matchedApartment) return null;
    if (matchedApartment.listingMode === "WHOLE") return "WHOLE";
    if (matchedApartment.listingMode === "PARTITIONED") return "PARTITION";
    return null;
  }, [matchedApartment]);
  const unitTypeOptions = (roomTypesQuery.data ?? [])
    .slice()
    .filter((r) => roomTypeFilterKind === null || r.kind === roomTypeFilterKind)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({ value: r.name, label: r.name }));

  // Org-curated amenity catalog (portal-scoped — agents see the same active
  // list as admins via /portal-api/inventory/amenities).
  const amenitiesQuery = usePortalAmenities();

  // Existing apartments under the selected property (typeahead source).
  // Only loaded when a property is selected. The backend already filters
  // to apartments where the caller has at least one visible sibling.
  const apartmentsQuery = useQuery({
    queryKey: ["portal-apartments-by-property", shared.propertyId],
    queryFn: () => portalGetApartmentsByProperty(shared.propertyId),
    enabled: !!shared.propertyId,
    staleTime: 30_000,
  });
  // Dropdown suggestions: filter by what the user typed; cap at 8 to keep
  // the list scannable.
  const suggestions = useMemo(() => {
    const apartments = apartmentsQuery.data ?? [];
    const q = unitCodeDraft.trim().toLowerCase();
    if (!q) return apartments.slice(0, 8);
    return apartments
      .filter((a) => a.unitCode.toLowerCase().includes(q))
      .slice(0, 8);
  }, [apartmentsQuery.data, unitCodeDraft]);

  // Ownership gate: true only when EVERY existing sibling is in-charge'd
  // to the calling agent. NULL inChargePartyId counts as "not owned"
  // (legacy / admin-managed) — see spec §"inChargePartyId = NULL semantics".
  const agentOwnsAllSiblings = useMemo(() => {
    if (!matchedApartment) return true; // no match → no gate
    if (!myPartyId) return false;
    return matchedApartment.rooms.every((r) => r.inChargePartyId === myPartyId);
  }, [matchedApartment, myPartyId]);

  // Apartment-scoped delta — only meaningful when an apartment is matched.
  const apartmentChanged = useMemo(() => {
    if (!match) return [];
    return sharedScopedChangedFields(match.initialShared, shared);
  }, [shared, match]);

  function selectApartment(apt: PortalApartmentSummary) {
    const next = apartmentSummaryToShared(apt, shared.propertyId);
    setShared(next);
    setUnitCodeDraft(apt.unitCode);
    setMatch({ apartment: apt, initialShared: next });
    setTypeaheadOpen(false);
  }

  function clearApartmentMatch() {
    setMatch(null);
  }

  const create = useMutation({
    mutationFn: (applyToExistingSiblings: boolean) => {
      // Materialize rooms: any room flagged "same as Room 1" inherits the
      // Room 1 deposit + parking values. Done at the serialization boundary
      // so the form state stays clean — the UI doesn't have to keep two
      // sources of truth in sync.
      const room1 = rooms[0];
      const materializedRooms: CreatePortalUnitsBatchRoom[] = rooms.map(
        (r, i) =>
          i > 0 && sameAsRoom1[i]
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
      const payload: CreatePortalUnitsBatchPayload = {
        shared,
        rooms: materializedRooms,
        ...(applyToExistingSiblings ? { applyToExistingSiblings: true } : {}),
      };
      return createPortalUnitsBatch(payload);
    },
    onSuccess: (data) => {
      const createdCount = data.ids.length;
      const updatedCount = data.updatedIds.length;
      let msg: string;
      if (createdCount === 0 && updatedCount > 0) {
        msg = `Apartment details updated (${updatedCount} room${
          updatedCount === 1 ? "" : "s"
        }).`;
      } else if (createdCount === 1) {
        msg = "Unit submitted — admin will review it.";
      } else {
        msg = `${createdCount} rooms submitted — admin will review them.`;
      }
      toast.success(msg);
      navigate("/portal/sales-pipeline");
    },
    onError: (err: Error) => {
      // Defense in depth: the UI gate already hides the fan-out path when
      // the agent doesn't own every sibling. If the server still rejects
      // (race / stale cache / direct mutation), surface a friendly toast
      // rather than the raw "APARTMENT_NOT_OWNED" string.
      if (err.message === "APARTMENT_NOT_OWNED") {
        toast.error(
          "This apartment is managed by another agent — you can only add new rooms, not change apartment-level fields.",
        );
        return;
      }
      toast.error(err.message || "Failed to submit");
    },
  });

  // Duplicate-unit-type guard mirrors the server-side check. Returns the
  // first duplicate string, or null. Keeps the Submit button disabled
  // until the agent fixes the duplicate. Also rejects collisions against
  // existing siblings when an apartment is matched.
  const duplicateUnitType = (() => {
    const seen = new Set<string>();
    if (matchedApartment) {
      for (const r of matchedApartment.rooms) seen.add(r.unitType.trim());
    }
    for (const r of rooms) {
      const t = r.unitType.trim();
      if (!t) continue;
      if (seen.has(t)) return t;
      seen.add(t);
    }
    return null;
  })();

  const sharedReadOnly = matchedApartment !== null && !agentOwnsAllSiblings;
  const fanOutAvailable = matchedApartment !== null && agentOwnsAllSiblings;

  // Allow empty rooms list when we're doing an apartment-only edit
  // (matched + owned + at least one apartment-scoped field changed).
  // Otherwise require ≥1 room. Mirrors admin parity.
  const isApartmentOnlyEdit =
    fanOutAvailable && rooms.length === 0 && apartmentChanged.length > 0;

  // Each room must have a unitType AND both deposit-months fields populated.
  // Rooms past the first inherit deposits from Room 1 when `sameAsRoom1[i]`
  // is true — in that case the room's own deposit fields are hidden and the
  // values come from Room 1 at materialization time. Room 1 itself must
  // always declare its own deposits.
  const roomsValid =
    rooms.length > 0 &&
    rooms.every((r, i) => {
      if (r.unitType.trim() === "") return false;
      const inheritsFromRoom1 = i > 0 && sameAsRoom1[i] === true;
      if (inheritsFromRoom1) return true;
      return r.depositMonths !== undefined && r.utilitiesDepositMonths !== undefined;
    });

  const canSubmit =
    !!shared.propertyId &&
    shared.unitCode.trim() !== "" &&
    duplicateUnitType === null &&
    (isApartmentOnlyEdit || roomsValid);

  function patchRoom(index: number, patch: Partial<CreatePortalUnitsBatchRoom>) {
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

  function onSubmit() {
    // Fan-out path: matched apartment + agent owns all + apartment-scoped
    // field(s) changed → confirmation modal before mutation. Pure additive
    // path (no shared changes, OR no match, OR not owned) → fire mutation
    // directly without the flag.
    if (fanOutAvailable && apartmentChanged.length > 0) {
      setConfirmFanOut(apartmentChanged);
      return;
    }
    create.mutate(false);
  }

  function submitButtonLabel(): string {
    if (create.isPending) return "Submitting…";
    if (fanOutAvailable && apartmentChanged.length > 0) {
      if (rooms.length === 0) return "Update apartment details";
      return `Update apartment + ${rooms.length} room${
        rooms.length === 1 ? "" : "s"
      }`;
    }
    if (rooms.length === 1) return "Submit for review";
    return `Submit ${rooms.length} rooms for review`;
  }

  const pickedProperty = (propsQuery.data ?? []).find(
    (p) => p.id === shared.propertyId,
  );

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>

      <div>
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <Building2 className="h-6 w-6 text-primary" /> New rental listing
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Add one or more rooms under the same apartment. Submission lands in
          the source queue; an admin will approve, reject, or request
          amendment. You can edit while still pending.
        </p>
      </div>

      {/* SHARED — property + unit-code level */}
      <Card>
        <CardHeader>
          <CardTitle>Apartment details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="block flex-1">
                <span className="text-xs text-muted-foreground">Property *</span>
                <select
                  value={shared.propertyId}
                  onChange={(e) => {
                    // Switching property invalidates any prior apartment
                    // match (different property has different apartments).
                    setShared({ ...shared, propertyId: e.target.value });
                    setUnitCodeDraft("");
                    clearApartmentMatch();
                  }}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  disabled={propsQuery.isLoading}
                >
                  <option value="">
                    {propsQuery.isLoading ? "Loading…" : "Pick a property…"}
                  </option>
                  {(propsQuery.data ?? []).map((p) => {
                    // PropertySubmission rows have `id=null` and surface via
                    // `submissionId`; until property submission attach-by-id
                    // is wired the form picker only supports approved Property
                    // rows. TODO (Phase C follow-up): wire propertySubmissionId
                    // attach path so agents can file unit submissions against
                    // their own pending properties.
                    const key = p.id ?? p.submissionId ?? p.propertyCode;
                    const value = p.id ?? "";
                    return (
                      <option key={key} value={value} disabled={!p.id}>
                        {p.name} · {p.propertyCode}
                        {p.sourcingApproved === false ? "  (pending)" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPropertyDialogOpen(true)}
                className="shrink-0 mt-5"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> New property
              </Button>
            </div>
            {pickedProperty && pickedProperty.sourcingApproved === false && (
              <Badge variant="outline" className="text-xs">
                Pending admin approval — you can still submit rooms
              </Badge>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block relative">
              <span className="text-xs text-muted-foreground">Unit code *</span>
              <Input
                value={unitCodeDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setUnitCodeDraft(v);
                  setTypeaheadOpen(true);
                  // While the user is editing the unit code, clear any
                  // previous match. Re-selection from the dropdown is the
                  // only way to re-establish a match (prevents stealthy
                  // typed-over-canonical-casing). The shared.unitCode value
                  // tracks the draft for the no-match path.
                  if (matchedApartment) clearApartmentMatch();
                  setShared((s) => ({ ...s, unitCode: v }));
                }}
                onFocus={() => setTypeaheadOpen(true)}
                onBlur={() => {
                  // Defer so a click on a dropdown row registers before the
                  // dropdown unmounts. 150ms is the usual heuristic.
                  setTimeout(() => setTypeaheadOpen(false), 150);
                }}
                placeholder="e.g. B-08-08"
                aria-autocomplete="list"
                aria-expanded={typeaheadOpen}
                role="combobox"
              />
              {typeaheadOpen && !!shared.propertyId && suggestions.length > 0 && (
                <div
                  role="listbox"
                  className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-md border border-input bg-popover shadow-md"
                >
                  {suggestions.map((apt) => (
                    <button
                      key={apt.unitCode}
                      type="button"
                      role="option"
                      aria-selected={
                        matchedApartment?.unitCode === apt.unitCode
                      }
                      // onMouseDown (not onClick) so the click registers
                      // BEFORE the input's onBlur fires its 150ms close.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectApartment(apt);
                      }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/60"
                    >
                      <div className="font-mono">{apt.unitCode}</div>
                      <div className="text-xs text-muted-foreground">
                        {apt.rooms.length} existing room
                        {apt.rooms.length === 1 ? "" : "s"}
                        {apt.bedrooms != null
                          ? ` · ${apt.bedrooms} BR`
                          : ""}
                        {apt.bathrooms != null
                          ? ` · ${apt.bathrooms} BA`
                          : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Floor</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={shared.floor ?? ""}
                onChange={(e) =>
                  setShared({
                    ...shared,
                    floor: parseNonNegative(e.target.value),
                  })
                }
                disabled={sharedReadOnly}
              />
            </label>
          </div>

          {sharedReadOnly && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
            >
              <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Apartment-level details are managed by the admin or the
                original sourcing agent. You can still add your own rooms
                below.
              </span>
            </div>
          )}

          {matchedApartment?.hasDrift && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
            >
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                This apartment&rsquo;s existing rooms disagree on shared
                fields. Values shown are from the earliest-created room.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Bedrooms (apartment)
              </span>
              <Input
                type="number"
                min={0}
                step={1}
                value={shared.bedrooms ?? ""}
                onChange={(e) =>
                  setShared({ ...shared, bedrooms: parseNonNegative(e.target.value) })
                }
                disabled={sharedReadOnly}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Bathrooms (apartment)
              </span>
              <Input
                type="number"
                min={0}
                step={1}
                value={shared.bathrooms ?? ""}
                onChange={(e) =>
                  setShared({ ...shared, bathrooms: parseNonNegative(e.target.value) })
                }
                disabled={sharedReadOnly}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Floor area (sqft)
              </span>
              <Input
                type="number"
                min={0}
                step={1}
                value={shared.floorArea ?? ""}
                onChange={(e) =>
                  setShared({ ...shared, floorArea: parseNonNegative(e.target.value) })
                }
                disabled={sharedReadOnly}
              />
            </label>
          </div>

          {/* Amenities — apartment-level. Same catalog as the admin Create
              dialog; shared across every room of this apartment.
              Wrapped in <div> not <label>: a <label> auto-activates its first
              labelable descendant on any non-button click, which fired the
              first chip's remove button when clicking the chip text. */}
          <div className="block">
            <span className="text-xs text-muted-foreground">
              Amenities (apartment)
            </span>
            <div
              className={`mt-1 ${
                sharedReadOnly ? "opacity-60 pointer-events-none" : ""
              }`}
              aria-disabled={sharedReadOnly}
              data-testid="apartment-amenities"
            >
              <AmenityCombobox
                value={shared.amenities ?? []}
                onChange={(amenities) => setShared({ ...shared, amenities })}
                catalog={amenitiesQuery.data ?? []}
                disabled={amenitiesQuery.isLoading || sharedReadOnly}
              />
            </div>
          </div>

          {/* Highlights — free-form per-apartment selling points. Distinct
              from Amenities (catalog) — these are non-standardized taglines
              like "Near KLCC" or "Corner unit" that don't belong in the
              filter facet. Apartment-scoped (parallel to amenities). */}
          <div className="block">
            <span className="text-xs text-muted-foreground">
              Highlights (apartment)
            </span>
            <p className="text-[11px] text-muted-foreground/80 mb-1">
              Free-form selling points specific to this apartment — &ldquo;Near
              KLCC&rdquo;, &ldquo;Corner unit&rdquo;, &ldquo;Renovated
              2025&rdquo;. Comma or Enter to add. For standardized features
              like Pool or Gym, use Amenities above.
            </p>
            <div
              className={
                sharedReadOnly ? "opacity-60 pointer-events-none" : ""
              }
              aria-disabled={sharedReadOnly}
              data-testid="apartment-highlights"
            >
              <TagInput
                values={shared.highlights ?? []}
                onChange={(highlights) => setShared({ ...shared, highlights })}
                placeholder="Near KLCC, Corner unit…"
              />
            </div>
          </div>

          {/* Description — free-form notes about the apartment. Visible on
              the admin queue card and unit detail page. */}
          <label className="block">
            <span className="text-xs text-muted-foreground">
              Description (apartment)
            </span>
            <textarea
              value={shared.description ?? ""}
              onChange={(e) =>
                setShared({
                  ...shared,
                  description: e.target.value ? e.target.value : null,
                })
              }
              placeholder="Sunny corner unit with panoramic city view…"
              rows={4}
              disabled={sharedReadOnly}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </label>
        </CardContent>
      </Card>

      {/* EXISTING ROOMS — read-only context block. Only shown when the
          typeahead has matched an existing apartment. Lets the agent see
          what's already in the apartment before adding more rooms. */}
      {matchedApartment && matchedApartment.rooms.length > 0 && (
        <Card data-testid="existing-rooms-card">
          <CardHeader>
            <CardTitle className="text-base">
              Existing rooms in this apartment
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Already on file under {matchedApartment.unitCode}. You can add
              more rooms below.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {matchedApartment.rooms.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
                data-testid="existing-room-row"
              >
                <span className="font-medium">{r.unitType}</span>
                <span className="text-xs text-muted-foreground">
                  {r.rentalRate != null
                    ? `RM ${r.rentalRate.toLocaleString()}`
                    : "—"}
                  {r.occupancyStatus
                    ? ` · ${occupancyLabel(r.occupancyStatus)}`
                    : ""}
                  {` · ${listingLabel(r.listingStatus)}`}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ROOMS — each is a separate Unit row on submit */}
      <Card>
        <CardHeader>
          <CardTitle>
            {matchedApartment ? "Add rooms" : "Rooms"}
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {matchedApartment
              ? "Add new rooms under this apartment. Leave empty to update apartment-level fields only."
              : "Add a row for each room (Master, Medium, Single, …). Each row becomes its own listing — they share the apartment metadata but have their own rent + deposit + parking."}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
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
                      >
                        <option value="">
                          {roomTypesQuery.isLoading
                            ? "Loading…"
                            : unitTypeOptions.length === 0
                              ? "No unit types configured — ask admin"
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
                        step="0.01"
                        value={room.rentalRate ?? ""}
                        onChange={(e) =>
                          patchRoom(index, { rentalRate: parseNonNegative(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  {rooms.length > 1 && (
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

                {/* "Same as Room 1" — index 0 is the source of truth, so the
                    checkbox only appears on rooms 2..N. */}
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
                    {isOpen ? "Hide" : "Show"} deposits + parking for this room
                  </button>
                )}

                {reuse && (
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
                        : `${room1.utilitiesDepositMonths} ${room1.utilitiesDepositMonths > 1 ? "months" : "month"}`} · Access cards:{" "}
                      {room1.accessCardQuantity ?? 0} pc(s)
                    </div>
                    <div>
                      Parking: {room1.parkingQuantity ?? 0} spot(s)
                      {room1.parkingNumbers && room1.parkingNumbers.length > 0
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
                      onChange={(patch) => {
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
                        });
                      }}
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

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={addRoom}
              className="flex-1"
            >
              <Plus className="h-4 w-4 mr-1" /> Add another room
            </Button>
            {fanOutAvailable && rooms.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setRooms([]);
                  setExpanded({});
                  setSameAsRoom1({});
                }}
              >
                Remove all rooms (apartment-only edit)
              </Button>
            )}
          </div>

          {duplicateUnitType && (
            <p className="text-xs text-rose-600">
              {matchedApartment &&
              matchedApartment.rooms.some(
                (r) => r.unitType.trim() === duplicateUnitType,
              )
                ? `"${duplicateUnitType}" already exists in this apartment. Pick a different room type.`
                : `Duplicate room type "${duplicateUnitType}". Pick a different type or remove the duplicate row.`}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="gold"
          onClick={onSubmit}
          disabled={!canSubmit || create.isPending}
        >
          {submitButtonLabel()}
        </Button>
        <Button variant="ghost" onClick={() => navigate(-1)}>
          Cancel
        </Button>
      </div>

      <CreatePropertyDialog
        open={propertyDialogOpen}
        onOpenChange={setPropertyDialogOpen}
        onCreated={(propertyId) => {
          void queryClient.invalidateQueries({
            queryKey: ["portal-properties"],
          });
          setShared((s) => ({ ...s, propertyId }));
        }}
      />

      <ConfirmAlert
        open={confirmFanOut !== null}
        onCancel={() => setConfirmFanOut(null)}
        onConfirm={() => {
          setConfirmFanOut(null);
          create.mutate(true);
        }}
        title="Update apartment-level fields?"
        body={
          <span>
            You changed{" "}
            <strong>{confirmFanOut?.join(", ") ?? ""}</strong>. These fields
            apply to the whole apartment, so the change will also be saved to
            every existing room in this apartment
            {matchedApartment && matchedApartment.rooms.length > 0
              ? `: ${matchedApartment.rooms.map((r) => r.unitType).join(", ")}.`
              : "."}
          </span>
        }
        confirmLabel={
          rooms.length === 0
            ? "Update apartment details"
            : `Update apartment + ${rooms.length} room${
                rooms.length === 1 ? "" : "s"
              }`
        }
      />
    </div>
  );
}
