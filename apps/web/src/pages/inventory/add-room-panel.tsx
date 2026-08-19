// AddRoomPanel — "+ New Room" inside the Edit-apartment dialog.
//
// User ask (verbatim): "after creation... maybe the admin forget to add unit
// into the unit... and then they wanted to add later. But i dont see the add
// unit button and insertable details?"
//
// Adding a room to an existing apartment used to live in the standalone
// CreateRoomsMultiDialog ("+ Add rooms" on the apartment card). That dialog was
// removed as a duplicate of the Create-unit Partition path — but "go back to
// Create unit and retype the apartment's code" is not a workflow when you are
// already standing inside the apartment. This panel puts the operation where it
// belongs: a tab in the Edit dialog, next to the rooms it will sit beside.
//
// It captures exactly the fields the Create dialog's room strip captures — same
// <RoomDraftFields> component, same roomDraftToPayload mapper, same
// POST /inventory/units/batch endpoint — so a room added here is
// indistinguishable from a room added at Create time. In particular an Occupied
// room materialises a Tenancy in-transaction, with the same guards.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { ActionButton } from "@/components/form-ui";
import { Callout } from "@/components/ui/callout";
import type { RoomTypeOption } from "@/hooks/use-room-types";
import {
  createUnitsBatch,
  type ApartmentSummary,
  type CreateUnitsBatchSharedFields,
} from "@/api/inventory-units-batch";
import {
  RoomDraftFields,
  blankRoom,
  roomDraftToPayload,
  type RoomDraft,
} from "./partition-room-strip";
import {
  createRentRule,
  validateOccupancy,
  type OccupancyFieldErrors,
} from "./occupancy-fields";

/**
 * Apartment-scoped fields, echoed back unchanged so the batch endpoint resolves
 * the SAME apartment (it finds-or-creates on propertyId + unitCode) rather than
 * minting a second one.
 *
 * `applyToExistingSiblings` is deliberately NOT set: adding a room must never
 * rewrite the shared fields of the rooms already there. Sending the apartment's
 * CURRENT owner is safe and necessary — the service takes the
 * `inheritedOwnerPartyId != null` branch, skips the first-owner fan-out
 * entirely, and never re-points anyone; without it an Occupied new room would
 * 409 UNIT_HAS_NO_OWNER.
 */
export function buildAddRoomShared(
  apartment: ApartmentSummary,
  propertyId: string,
): CreateUnitsBatchSharedFields {
  return {
    propertyId,
    unitCode: apartment.unitCode,
    floor: apartment.floor ?? undefined,
    bedrooms: apartment.bedrooms ?? undefined,
    bathrooms: apartment.bathrooms ?? undefined,
    floorArea: apartment.floorArea ?? undefined,
    amenities: apartment.amenities.map((a) => a.id),
    highlights: apartment.highlights,
    description: apartment.description,
    ...(apartment.ownerPartyId ? { ownerPartyId: apartment.ownerPartyId } : {}),
    ...(apartment.partitionBillingMode
      ? { partitionBillingMode: apartment.partitionBillingMode }
      : {}),
  };
}

/**
 * Room types this apartment cannot reuse. LIVE siblings are the obvious case;
 * ARCHIVED siblings matter just as much, because the DB unique is
 * (apartmentId, listingType) regardless of listingStatus — deactivating a room
 * does not release its type. Creating over one 409s with the batch service's
 * P2002 mapping ("Some listing types already exist for this apartment"), which
 * names no room and offers no way forward. Exclude both, and tell the operator
 * that the archived twin is restorable.
 */
export function takenRoomTypes(apartment: ApartmentSummary): string[] {
  return [
    ...apartment.rooms.map((r) => r.unitType),
    ...(apartment.archivedRooms ?? []).map((r) => r.unitType),
  ].filter(Boolean);
}

export function AddRoomPanel({
  apartment,
  propertyId,
  onCreated,
  onCancel,
}: {
  apartment: ApartmentSummary;
  propertyId: string;
  /** Called with the new room's id so the shell can select its tab. */
  onCreated: (roomId: string | undefined) => void;
  onCancel: () => void;
}) {
  const [room, setRoom] = useState<RoomDraft>(() => blankRoom());
  const [errors, setErrors] = useState<OccupancyFieldErrors>({});
  const queryClient = useQueryClient();

  // Shares the cache key UnitFormBody already uses, so no extra fetch.
  const roomTypesQuery = useQuery({
    queryKey: ["inventory-unit-dialog", "room-types"],
    queryFn: () =>
      apiFetch<{ data: RoomTypeOption[] }>("/commissions/room-types?activeOnly=true"),
    staleTime: 60_000,
  });

  const roomTypeOptions = roomTypesQuery.data?.data ?? [];

  // Only archived types that this panel could otherwise OFFER are worth warning
  // about. The picker is locked to PARTITION kinds, so an archived "Whole Unit"
  // holds its slot in the unique index but was never selectable here — naming it
  // would be noise pointing at a Restore the operator doesn't want.
  const collidingArchivedTypes = (() => {
    const partitionNames = new Set(
      roomTypeOptions.filter((o) => o.kind === "PARTITION").map((o) => o.name),
    );
    return (apartment.archivedRooms ?? [])
      .map((r) => r.unitType)
      .filter((t) => partitionNames.has(t));
  })();

  const mutation = useMutation({
    mutationFn: () =>
      createUnitsBatch({
        shared: buildAddRoomShared(apartment, propertyId),
        rooms: [roomDraftToPayload(room)],
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({
        queryKey: ["inventory", "apartments-by-property"],
      });
      toast.success(`Room added to ${apartment.unitCode}.`);
      onCreated(data.ids[0]);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to add room.");
    },
  });

  function onSubmit() {
    if (!room.unitType.trim()) {
      toast.error("Pick a room type.");
      return;
    }
    // Deposits are REQUIRED by the batch schema (non-optional z.coerce.number).
    // roomDraftToPayload maps a blank to undefined, which JSON-drops, so an
    // unchecked room would 400 with no field anchor. Mirror the Create dialog.
    if (room.depositMonths.trim() === "") {
      toast.error("Rental deposit (months) is required.");
      return;
    }
    if (room.utilitiesDepositMonths.trim() === "") {
      toast.error("Utilities deposit (months) is required.");
      return;
    }
    if (room.occupancyStatus === "occupied") {
      // The server's UNIT_HAS_NO_OWNER guard fires inside the transaction and
      // maps to a 409 that names no control. Block here — the owner lives on
      // the apartment and is edited from any room's form, not from this panel.
      if (!apartment.ownerPartyId) {
        toast.error(
          "Assign an owner to this apartment before marking a room occupied — open any room tab and set the owner there first.",
        );
        return;
      }
      // Flag-derived, via createRentRule(). The batch loop's own pre-check uses
      // `monthlyRent ?? rentalRate`, but it hands the RAW `room.monthlyRent` to
      // syncOccupancyTenancy (inventory.service.ts:951), which under
      // ENABLE_PHASE2_RESERVATION_GATED_TENANCY demands an explicit rent.
      const occErrors = validateOccupancy(room, { rentRule: createRentRule() });
      if (Object.keys(occErrors).length > 0) {
        setErrors(occErrors);
        toast.error(
          "This room is Occupied — add its tenant, move-in/move-out dates and monthly rent before saving.",
        );
        return;
      }
    }
    setErrors({});
    mutation.mutate();
  }

  return (
    <div className="space-y-4">
      <Callout variant="info">
        A new room under <strong>{apartment.unitCode}</strong>. It inherits the
        apartment&apos;s floor, bedrooms, bathrooms, floor area, amenities,
        highlights, owner and billing model. Rent, deposits, parking and
        occupancy are this room&apos;s own.
      </Callout>

      {collidingArchivedTypes.length > 0 && (
        <Callout variant="warning" title="Some room types are held by archived rooms">
          {collidingArchivedTypes.join(", ")} — a deactivated room keeps its type
          reserved, so you cannot create a new one with the same name. Restore
          the archived room below instead of re-creating it.
        </Callout>
      )}

      <RoomDraftFields
        room={room}
        onChange={(patch) => {
          setErrors({});
          setRoom((prev) => ({ ...prev, ...patch }));
        }}
        options={roomTypeOptions}
        excludeNames={takenRoomTypes(apartment)}
        errors={errors}
      />

      <div className="flex items-center gap-2 pt-2">
        <ActionButton
          type="button"
          variant="primary"
          onClick={onSubmit}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Adding…" : "Add room"}
        </ActionButton>
        <ActionButton
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </ActionButton>
      </div>
    </div>
  );
}
