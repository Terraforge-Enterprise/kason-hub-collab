import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { computeManagementFee, type FeeType } from "@kason/shared";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  createUnitsBatch,
  getApartmentsByProperty,
  type CreateUnitsBatchRoom,
  type CreateUnitsBatchSharedFields,
} from "@/api/inventory-units-batch";
import type { RoomTypeOption } from "@/hooks/use-room-types";
import type { UnitMode } from "./unit-type-step";
import {
  PartitionRoomStrip,
  blankRoom,
  duplicateRoomTypes,
  roomDraftToPayload,
  roomHasData,
  type RoomDraft,
  type RoomPayload,
} from "./partition-room-strip";
import {
  createRentRule,
  validateOccupancy,
  type OccupancyFieldErrors,
} from "./occupancy-fields";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ActionButton, SelectInput, TextInput } from "@/components/form-ui";
import {
  blankUnitFormState,
  UnitFormBody,
  unitFormToApiPayload,
  type UnitFormErrors,
  type UnitFormState,
} from "./unit-form-fields";
import { CreateUnitMediaStep, type CreatedRoom } from "./unit-media-step";

export type PropertyOption = { id: string; name: string; propertyCode: string };

type CreateManagementFeeState = {
  enabled: boolean;
  feeType: FeeType;
  feeValue: string;
  capAmount: string;
  sstPercent: string;
  freePeriodStart: string;
  freePeriodEnd: string;
};

const blankManagementFee = (): CreateManagementFeeState => ({
  enabled: true,
  feeType: "percent",
  feeValue: "10",
  capAmount: "",
  sstPercent: "8",
  freePeriodStart: "",
  freePeriodEnd: "",
});

function dateInputToIso(value: string): string | null {
  return value ? `${value}T00:00:00.000Z` : null;
}

function sixMonthFreePeriod(moveInDate: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moveInDate)) return null;
  const [year, month, day] = moveInDate.split("-").map(Number);
  const start = new Date(Date.UTC(year!, month! - 1, day));
  const afterSixMonths = new Date(Date.UTC(year!, month! - 1 + 6, day));
  afterSixMonths.setUTCDate(afterSixMonths.getUTCDate() - 1);
  const toInput = (date: Date) => date.toISOString().slice(0, 10);
  return { start: toInput(start), end: toInput(afterSixMonths) };
}

/**
 * Server codes that name a control on this form. Surfacing them beside the
 * offending field beats a toast the admin must translate back into an action.
 * `extractApiError` already normalises both wire shapes — the 409s carry `code`
 * as a top-level sibling of `error`, the 400 nests it under `error` — so a
 * single lookup on `err.code` covers all four.
 */
const SERVER_CODE_TO_FIELD: Record<string, keyof UnitFormErrors> = {
  UNIT_HAS_NO_OWNER: "ownerPartyId",
  APARTMENT_OWNER_CONFLICT: "ownerPartyId",
  OCCUPANCY_RENT_REQUIRED: "monthlyRent",
  APARTMENT_BILLING_MODE_CONFLICT: "partitionBillingMode",
};

/**
 * Shape a Partition submission for the batch endpoint. Apartment-level fields
 * (unit code, floor, bedrooms, bathrooms, floor area, amenities, highlights,
 * description, in-charge, owner, billing model) are entered once and reused on
 * `shared`; rent, deposits, cards, parking and occupancy are per room. The
 * numeric coercion is reused from unitFormToApiPayload (with the same create
 * opt-ins), then only the batch-`shared`-allowed keys are picked. The batch
 * envelope and each room (adminBatchRoomFields) are `.strict()`, so a stray
 * key there would 400; the inner `shared` is not strict (it would silently
 * strip an unknown key), so we pick explicitly rather than rely on the schema
 * to reject extras.
 */
export function buildPartitionPayload(
  form: UnitFormState,
  propertyId: string,
  rooms: RoomDraft[],
): { shared: CreateUnitsBatchSharedFields; rooms: RoomPayload[] } {
  const full = unitFormToApiPayload(form, {
    includeOwner: true,
    includeBillingMode: true,
    includeRent: true,
  });
  const shared: CreateUnitsBatchSharedFields = {
    propertyId,
    unitCode: full.unitCode,
    floor: full.floor,
    bedrooms: full.bedrooms,
    bathrooms: full.bathrooms,
    floorArea: full.floorArea,
    amenities: full.amenities,
    highlights: full.highlights,
    description: full.description,
    inChargePartyId: full.inChargePartyId,
    ...(form.ownerPartyId ? { ownerPartyId: form.ownerPartyId } : {}),
    ...(form.partitionBillingMode
      ? { partitionBillingMode: form.partitionBillingMode as "SUBSIDY" | "NO_SUBSIDY" }
      : {}),
  };
  // roomDraftToPayload is shared with the Edit dialog's Add-room panel — both
  // POST the same batch endpoint, so the money-carrying mapping lives once.
  return { shared, rooms: rooms.map(roomDraftToPayload) };
}

/**
 * Within-batch duplicate room-type guard. Returns a message naming the
 * offending type(s), or null when the set is distinct. Empty-type rows are
 * ignored (they're incomplete, not duplicates). The strip's per-room type
 * dropdown already excludes sibling types, so this is a defense-in-depth
 * backstop; the DB unique (apartmentId, listingType) + P2002 backstop
 * collisions against existing siblings the strip cannot see.
 */
export function partitionDuplicateError(rooms: RoomDraft[]): string | null {
  const dups = duplicateRoomTypes(rooms.filter((r) => r.unitType.trim() !== ""));
  return dups.length > 0
    ? `Each room needs a distinct type. Duplicated: ${dups.join(", ")}.`
    : null;
}

export function CreateUnitDialog({
  trigger,
  properties,
  defaultPropertyId,
}: {
  trigger: ReactNode;
  properties: PropertyOption[];
  defaultPropertyId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [propertyId, setPropertyId] = useState<string>(defaultPropertyId ?? "");
  const [form, setForm] = useState<UnitFormState>(blankUnitFormState());
  const [errors, setErrors] = useState<UnitFormErrors>({});
  // Step-1 mode surfaced by UnitFormBody. "PARTITIONED" swaps the single-unit
  // submit for the multi-room batch and reveals the per-room strip.
  const [mode, setMode] = useState<UnitMode | null>(null);
  // Per-room drafts for the Partition path. Seeded with one room so the strip
  // always has a Room 1. Never shares object references across rooms — editing
  // one room's rent must leave the others untouched.
  const [rooms, setRooms] = useState<RoomDraft[]>(() => [blankRoom()]);
  const [activeRoomIndex, setActiveRoomIndex] = useState(0);
  // Occupancy field errors for the ACTIVE room. The strip renders one
  // <OccupancyFields> at a time (the active room), so a per-room error object
  // scoped to the active room is all it can display. Set by the pre-submit
  // occupancy check below; cleared whenever the operator switches rooms or
  // edits any room (so a fixed field dismisses its own error).
  const [roomErrors, setRoomErrors] = useState<OccupancyFieldErrors>({});
  // Two-phase create: after a successful save the dialog does NOT close — it
  // shows the media step for the created listing(s). null = still on the form.
  const [mediaStep, setMediaStep] = useState<CreatedRoom[] | null>(null);
  const [managementFee, setManagementFee] = useState<CreateManagementFeeState>(
    blankManagementFee,
  );
  const queryClient = useQueryClient();

  // Active Room Types for the per-room type picker in the strip. Shares the
  // react-query cache key UnitFormBody already uses, so opening the dialog
  // fetches once and both consumers read the same list.
  const roomTypesQuery = useQuery({
    queryKey: ["inventory-unit-dialog", "room-types"],
    queryFn: () =>
      apiFetch<{ data: RoomTypeOption[] }>(
        "/commissions/room-types?activeOnly=true",
      ),
    enabled: open,
    staleTime: 60_000,
  });
  const roomTypeOptions = roomTypesQuery.data?.data ?? [];

  // Apartments already on this property. A unit code that matches one means the
  // admin is adding a ROOM to an existing apartment, which already carries an
  // owner and a billing model — both apartment-scoped, both fields the server
  // will 409 on if this create contradicts them.
  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments-by-property", propertyId],
    queryFn: () => getApartmentsByProperty(propertyId),
    enabled: open && propertyId !== "",
    staleTime: 30_000,
  });

  const matchedApartment = useMemo(() => {
    const code = form.unitCode.trim().toLowerCase();
    if (!code) return null;
    return (
      (apartmentsQuery.data ?? []).find(
        (a) => a.unitCode.trim().toLowerCase() === code,
      ) ?? null
    );
  }, [apartmentsQuery.data, form.unitCode]);

  const managementFeePreview = useMemo(() => {
    if (!managementFee.enabled) return null;
    const rent = form.monthlyRent.trim() || form.rentalRate.trim();
    if (!rent || !managementFee.feeValue || !managementFee.sstPercent) return null;
    try {
      return computeManagementFee(
        {
          feeType: managementFee.feeType,
          feeValue: managementFee.feeValue,
          capAmount:
            managementFee.feeType === "cap" ? managementFee.capAmount : null,
          sstPercent: managementFee.sstPercent,
        },
        rent,
      );
    } catch {
      return null;
    }
  }, [form.monthlyRent, form.rentalRate, managementFee]);

  // Pre-fill owner + billing model from the matched apartment, once per match,
  // so the admin sees what the new room will inherit and cannot unknowingly
  // submit a conflicting value. Keyed on the apartment id rather than the
  // object, so re-renders never clobber an edit the admin made afterwards.
  const prefilledApartmentId = useRef<string | null>(null);
  useEffect(() => {
    const id = matchedApartment?.id ?? null;
    if (id === prefilledApartmentId.current) return;
    prefilledApartmentId.current = id;
    if (!matchedApartment) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    setForm((prev) => ({
      ...prev,
      partitionBillingMode:
        matchedApartment.partitionBillingMode ?? prev.partitionBillingMode,
      ...(matchedApartment.ownerPartyId
        ? {
            ownerPartyId: matchedApartment.ownerPartyId,
            ownerName: matchedApartment.ownerName ?? "",
            ownerPhone: matchedApartment.ownerPhone,
          }
        : {}),
    }));
  }, [matchedApartment]);

  // Reset on close so reopening doesn't keep the previous draft.
  function onOpenChange(next: boolean) {
    if (!next) {
      setForm(blankUnitFormState());
      setPropertyId(defaultPropertyId ?? "");
      setErrors({});
      setMode(null);
      setRooms([blankRoom()]);
      setActiveRoomIndex(0);
      setRoomErrors({});
      setMediaStep(null);
      setManagementFee(blankManagementFee());
      prefilledApartmentId.current = null;
    }
    setOpen(next);
  }

  async function createManagementFeeConfig(apartmentId: string) {
    if (!managementFee.enabled || !form.ownerPartyId || matchedApartment) return null;
    try {
      await apiFetch("/owner-billing/fee-configs", {
        method: "POST",
        body: JSON.stringify({
          ownerPartyId: form.ownerPartyId,
          propertyId,
          apartmentId,
          feeType: managementFee.feeType,
          feeValue: managementFee.feeValue,
          capAmount:
            managementFee.feeType === "cap" ? managementFee.capAmount : null,
          sstPercent: managementFee.sstPercent,
          freePeriodStart: dateInputToIso(managementFee.freePeriodStart),
          freePeriodEnd: dateInputToIso(managementFee.freePeriodEnd),
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["owner-fee-configs"] });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Unknown error";
    }
  }

  async function registerCreatedCarparks(apartmentId: string) {
    if (matchedApartment || Number(form.parkingQuantity || 0) <= 0) return null;
    try {
      const quantity = Number(form.parkingQuantity);
      await Promise.all(
        Array.from({ length: quantity }, (_, index) =>
          apiFetch("/carparks", {
            method: "POST",
            body: JSON.stringify({
              apartmentId,
              label: form.parkingNumbers[index]?.trim() || `Parking ${index + 1}`,
              monthlyRate: form.parkingMonthlyRates[index]?.trim() || "0",
            }),
          }),
        ),
      );
      queryClient.invalidateQueries({ queryKey: ["carparks"] });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Unknown carpark setup error";
    }
  }

  const mutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const response = await apiFetch<{
        id?: string;
        apartmentId?: string;
        warnings?: string[];
      }>("/inventory/units", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const setupWarnings: string[] = [];
      if (response.apartmentId) {
        const feeWarning = await createManagementFeeConfig(response.apartmentId);
        if (feeWarning) setupWarnings.push(`management fee: ${feeWarning}`);
        const carparkWarning = await registerCreatedCarparks(response.apartmentId);
        if (carparkWarning) setupWarnings.push(`carparks: ${carparkWarning}`);
      }
      return { ...response, setupWarning: setupWarnings.join("; ") || null };
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      // Coerce-to-draft: server flipped listingStatus to "draft" because
      // required-for-publish fields were missing. Surface a warning toast
      // (yellow) instead of the standard success toast.
      if (response.setupWarning) {
        toast.warning(
          `Unit created, but related setup needs attention: ${response.setupWarning}.`,
          { duration: 9000 },
        );
      } else if (response?.warnings && response.warnings.length > 0) {
        toast.warning(response.warnings.join(" "));
      } else {
        toast.success("Unit created.");
      }
      if (response?.id) {
        setMediaStep([{ id: response.id, label: form.unitCode.trim() || "New unit" }]);
      } else {
        onOpenChange(false);
      }
    },
    onError: (err: Error) => {
      if (err instanceof ApiError) {
        if (err.code === "LISTING_MODE_MISMATCH") {
          const data = err.data as { currentMode?: string; attemptedKind?: string } | null;
          const current = data?.currentMode === "PARTITIONED" ? "Partitioned" : "Whole";
          const attempted = data?.attemptedKind === "WHOLE" ? "Whole" : "Partitioned";
          toast.error(
            `An existing room with this unit code is ${current}. The unit type you picked is a ${attempted} type — open that unit's Edit modal and switch its listing mode there first, then add this room.`,
            { duration: 8000 },
          );
          return;
        }
        const field = err.code ? SERVER_CODE_TO_FIELD[err.code] : undefined;
        if (field) {
          setErrors((prev) => ({ ...prev, [field]: err.message }));
          return;
        }
      }
      // Unknown code: never swallow it — fall back to the server's message.
      toast.error(err.message || "Failed to create unit.");
    },
  });

  // Partition path: one submission fans out into N sibling rooms via the batch
  // endpoint. Owner + billing model ride on `shared` (apartment-scoped); rent,
  // deposits, cards and parking are per room.
  const batchMutation = useMutation({
    mutationFn: (body: {
      shared: CreateUnitsBatchSharedFields;
      rooms: CreateUnitsBatchRoom[];
    }) => createUnitsBatch(body).then(async (data) => ({
      ...data,
      feeConfigWarning: data.apartmentId
        ? await createManagementFeeConfig(data.apartmentId)
        : null,
    })),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      const n = data.ids.length;
      if (data.feeConfigWarning) {
        toast.warning(
          `${n === 1 ? "Room" : `${n} rooms`} created, but management fee setup failed: ${data.feeConfigWarning}.`,
          { duration: 9000 },
        );
      } else {
        toast.success(n === 1 ? "Room created." : `${n} rooms created.`);
      }
      if (n > 0) {
        setMediaStep(
          data.ids.map((id, i) => ({
            id,
            label: variables.rooms[i]?.unitType?.trim() || `Room ${i + 1}`,
          })),
        );
      } else {
        onOpenChange(false);
      }
    },
    onError: (err: Error) => {
      // A room type that collides with an EXISTING sibling (incl. archived rows
      // the by-property payload hides) 409s server-side. Surface that message
      // faithfully rather than swallowing it — the client-side dup check only
      // sees the rooms in this submission.
      if (err instanceof ApiError) {
        const field = err.code ? SERVER_CODE_TO_FIELD[err.code] : undefined;
        // Owner + billing-model codes name a control that IS visible in
        // Partition mode (both ride on `shared`), so anchor them there too.
        if (field) {
          setErrors((prev) => ({ ...prev, [field]: err.message }));
        }
      }
      // ALWAYS surface a visible toast on the batch path — never a silent
      // setErrors-then-return. A per-room occupancy 400 (OCCUPANCY_RENT_REQUIRED,
      // or the trio-required refiner message) maps to a field on the strip's
      // OccupancyFields, which is per-ACTIVE-room; the dialog can't attribute a
      // server 400 to a room index, so a field-only surface would render nowhere
      // (the apartment-level OccupancyFields is hidden in Partition mode) and the
      // modal would look frozen. The server's message is already descriptive.
      // The pre-submit check in onSubmit catches these client-side first, with
      // proper per-room attribution — this toast is the guaranteed safety net.
      toast.error(err.message || "Failed to create rooms.");
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!propertyId) {
      toast.error("Pick a property first.");
      return;
    }
    if (!form.unitCode.trim()) {
      toast.error("Unit code is required.");
      return;
    }
    if (form.ownerPartyId && !matchedApartment && managementFee.enabled) {
      if (!/^\d+(\.\d{1,2})?$/.test(managementFee.feeValue)) {
        toast.error("Enter a valid management fee value (maximum 2 decimal places).");
        return;
      }
      if (!/^\d+(\.\d{1,2})?$/.test(managementFee.sstPercent)) {
        toast.error("Enter a valid SST percentage.");
        return;
      }
      if (
        managementFee.feeType === "cap" &&
        !/^\d+(\.\d{1,2})?$/.test(managementFee.capAmount)
      ) {
        toast.error("Enter the management fee cap amount.");
        return;
      }
      if (Boolean(managementFee.freePeriodStart) !== Boolean(managementFee.freePeriodEnd)) {
        toast.error("Set both the free-period start and end dates, or leave both blank.");
        return;
      }
      if (
        managementFee.freePeriodStart &&
        managementFee.freePeriodEnd &&
        managementFee.freePeriodEnd < managementFee.freePeriodStart
      ) {
        toast.error("Management fee free-period end cannot be before its start.");
        return;
      }
    }

    // Partition: route to the batch endpoint. Branches BEFORE the single-unit
    // required-field checks (unit type, deposit-months) — those are per-room in
    // this mode and live on the strip, not the top-level form.
    if (mode === "PARTITIONED") {
      // Defence in depth. These fields are HIDDEN in Partition mode
      // (unit-form-fields gates them behind the same PARTITIONED check), so none
      // can deviate through the UI — buildPartitionPayload maps NONE of them onto
      // the batch body. If a future refactor un-hides one, fail loudly here
      // instead of silently discarding the admin's input. Each guard names its
      // own field so the toast points the admin at what to reset.
      if (form.occupancyStatus !== "vacant") {
        toast.error("Lifecycle is set on each room after it exists — reset it to Vacant here.");
        return;
      }
      if (form.tenantPartyId) {
        toast.error("A tenant is assigned on each room after it exists — remove the tenant here.");
        return;
      }
      // Sourcing agent + its derived Source ride on the WHOLE unit, and the
      // batch endpoint carries no sourcing field. A value set in Whole mode
      // persists across the flip to Partition (the control is then hidden), so
      // submitting would silently drop the attribution (rooms land
      // COMPANY-sourced, the agent demoted to in-charge-only) — commission
      // relevant. Block and point the admin back to the Whole control.
      if (form.sourcingAgentId) {
        toast.error("A sourcing agent rides on the whole unit, not a partitioned create — switch back to Whole Unit to clear it, then re-pick Partition.");
        return;
      }
      if (form.listingStatus !== "draft") {
        toast.error("Rooms are created as Draft — leave listing status as Draft here.");
        return;
      }
      if (form.visibilityMode !== "PUBLIC") {
        toast.error("Visibility is set on each room after it exists — leave it Public here.");
        return;
      }
      // PUBLIC passes the visibilityMode guard above, but its "Hidden from"
      // blocklist has nowhere to go on the batch body. A list set in Whole mode
      // persists across the flip (the control is hidden in Partition), so
      // submitting would leave the created rooms visible to agents the admin
      // explicitly hid. Block and name the control.
      if (form.hiddenFromPartyIds.length > 0) {
        toast.error("The PUBLIC “Hidden from” list applies to the whole unit, not a partitioned create — switch back to Whole Unit to clear it before continuing.");
        return;
      }
      if (form.hasPaxDeduction) {
        toast.error("Pax deduction cannot be set on a partitioned create.");
        return;
      }
      // The top-level Unit type is meaningless on the batch path (types are
      // captured per room in the strip; buildPartitionPayload never maps
      // form.unitType). The step-2 dropdown is hidden in Partition mode and the
      // mode flip clears a Whole-kind selection, so this only fires if a future
      // refactor un-hides the control — fail loudly rather than discard it.
      if (form.unitType) {
        toast.error("Room types are set per room below — the top-level Unit type doesn't apply to a partitioned create.");
        return;
      }
      const withType = rooms.filter((r) => r.unitType.trim() !== "");
      if (withType.length === 0) {
        toast.error("Add at least one room and pick its type.");
        return;
      }
      // A room carrying rent/deposits/cards/parking but no type would be
      // dropped by the withType filter above — its data lost with no warning.
      // Block instead, naming the offending tab. A genuinely-blank trailing
      // room (roomHasData === false) is still safely ignored.
      const orphanIndex = rooms.findIndex(
        (r) => r.unitType.trim() === "" && roomHasData(r),
      );
      if (orphanIndex !== -1) {
        toast.error(`Room ${orphanIndex + 1} needs a type before it can be saved.`);
        return;
      }
      // Block within-batch duplicates before submit; name the offender. The DB
      // unique (apartmentId, listingType) + its P2002 remain the backstop for
      // collisions against existing siblings the strip cannot see.
      const dupError = partitionDuplicateError(withType);
      if (dupError) {
        toast.error(dupError);
        return;
      }
      // Per-room deposits are REQUIRED by the batch schema (batchRoomFields:
      // depositMonths + utilitiesDepositMonths are non-optional z.coerce.number).
      // buildPartitionPayload maps a blank input to undefined, which JSON-drops,
      // so an unchecked room would 400 server-side with no field anchor. Mirror
      // the Whole path's explicit deposit checks, naming the room by its type
      // (which matches the strip's tab label; types are distinct here).
      for (const r of withType) {
        if (r.depositMonths.trim() === "") {
          toast.error(`Room "${r.unitType}": rental deposit (months) is required.`);
          return;
        }
        if (r.utilitiesDepositMonths.trim() === "") {
          toast.error(`Room "${r.unitType}": utilities deposit (months) is required.`);
          return;
        }
      }
      // Per-room occupancy: an Occupied room needs a tenant + both dates + an
      // effective rent (`monthlyRent ?? rentalRate` > 0), exactly like the
      // single-unit occupied create — the batch loop ports createUnitService's
      // guards per room and would 400 otherwise (OCCUPANCY_RENT_REQUIRED, or
      // the trio-required refiner). Validate client-side so the offending room
      // is SELECTED and its fields flagged before any POST — the strip shows one
      // OccupancyFields at a time, so a server 400 (no room index) can't be
      // attributed to a room and would render nowhere. Clear any stale room
      // errors first so a fixed field doesn't keep a ghost message.
      setRoomErrors({});
      for (const r of withType) {
        if (r.occupancyStatus !== "occupied") continue;
        const occErrors = validateOccupancy(r, { rentRule: createRentRule() });
        if (Object.keys(occErrors).length > 0) {
          // rooms.indexOf: withType holds the SAME object references as rooms,
          // so this maps back to the strip's tab index for the offending room.
          setActiveRoomIndex(rooms.indexOf(r));
          setRoomErrors(occErrors);
          toast.error(
            `Room "${r.unitType}" is Occupied — add its tenant, move-in/move-out dates and monthly rent before saving.`,
          );
          return;
        }
      }
      batchMutation.mutate(buildPartitionPayload(form, propertyId, withType));
      return;
    }

    if (!form.unitType) {
      toast.error("Pick a unit type.");
      return;
    }
    if (form.depositMonths === "") {
      toast.error("Rental deposit (months) is required.");
      return;
    }
    if (form.utilitiesDepositMonths === "") {
      toast.error("Utilities deposit (months) is required.");
      return;
    }
    // Flag-derived, via createRentRule(). createUnitService's OWN pre-check does
    // resolve `monthlyRent ?? rentalRate` in every flag state — but it then hands
    // the RAW `input.monthlyRent` to syncOccupancyTenancy
    // (inventory.service.ts:1525), which under
    // ENABLE_PHASE2_RESERVATION_GATED_TENANCY throws OCCUPANCY_RENT_REQUIRED
    // rather than falling back to rentalRate. So "effective" is correct only
    // while the flag is off; with it on, an occupied create carrying just a
    // rental rate passes here and 400s on the server.
    const nextErrors: UnitFormErrors = validateOccupancy(form, {
      rentRule: createRentRule(),
    });
    // Occupied ⇒ owner required: either picked here, or already on the
    // apartment this room joins (createUnitService inherits it).
    if (
      form.occupancyStatus === "occupied" &&
      !form.ownerPartyId &&
      !matchedApartment?.ownerPartyId
    ) {
      nextErrors.ownerPartyId = "Assign an owner before marking this unit occupied.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload = {
      propertyId,
      ...unitFormToApiPayload(form, {
        includeOwner: true,
        includeBillingMode: true,
        includeRent: true,
      }),
    };
    mutation.mutate(payload);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mediaStep ? "Add photos & videos" : "Create unit"}</DialogTitle>
          <DialogDescription>
            {mediaStep
              ? "Your unit is created. Add photos and videos now, or click Done to finish."
              : "Add a rentable unit under an existing property. Code, type, and both deposit-months fields are required; other fields can be edited later."}
          </DialogDescription>
        </DialogHeader>

        {mediaStep ? (
          <CreateUnitMediaStep
            rooms={mediaStep}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ["inventory"] });
              onOpenChange(false);
            }}
          />
        ) : (
        /* noValidate: this dialog fully validates in JS below (every required
            field has an explicit check + toast), and the top-level deposit
            fields are `required` for the Whole path but per-room on the
            Partition path — native validation would otherwise block a valid
            Partition submit on empty apartment-level deposits. */
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <UnitFormBody
            state={form}
            setState={setForm}
            propertyOptions={properties}
            selectedPropertyId={propertyId}
            onSelectProperty={setPropertyId}
            propertyPlaceholderName={
              defaultPropertyId
                ? properties.find((p) => p.id === defaultPropertyId)?.name
                : undefined
            }
            showPropertySelect={!defaultPropertyId}
            showOwner
            ownerEditable
            allowCreateAgent
            showBillingModel
            alwaysShowRent
            partitionFieldsInStrip
            onModeChange={setMode}
            errors={errors}
          />

          {form.ownerPartyId && !matchedApartment && (
            <section className="rounded-xl border border-[#C9A35C]/60 bg-[#fffaf0] p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-[#082B4F]">Management fee setup</h3>
                  <p className="mt-1 text-sm text-[#657069]">
                    Saved directly to this unit and owner. A management fee is charged only in months with rental.
                  </p>
                </div>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-[#9DAFC1] bg-white px-3 text-sm font-semibold text-[#082B4F]">
                  <input
                    type="checkbox"
                    checked={managementFee.enabled}
                    onChange={(event) =>
                      setManagementFee((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />
                  Charge management fee
                </label>
              </div>

              {managementFee.enabled && (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 md:grid-cols-4">
                    <label className="space-y-1 text-sm font-semibold text-[#082B4F]">
                      <span>Fee type</span>
                      <SelectInput
                        value={managementFee.feeType}
                        onChange={(event) =>
                          setManagementFee((current) => ({
                            ...current,
                            feeType: event.target.value as FeeType,
                          }))
                        }
                      >
                        <option value="percent">Percent of rent</option>
                        <option value="fixed">Fixed RM</option>
                        <option value="cap">Percent with cap</option>
                      </SelectInput>
                    </label>
                    <label className="space-y-1 text-sm font-semibold text-[#082B4F]">
                      <span>{managementFee.feeType === "fixed" ? "Fee (RM)" : "Fee (%)"}</span>
                      <TextInput
                        type="number"
                        min="0"
                        step="0.01"
                        value={managementFee.feeValue}
                        onChange={(event) =>
                          setManagementFee((current) => ({ ...current, feeValue: event.target.value }))
                        }
                      />
                    </label>
                    {managementFee.feeType === "cap" && (
                      <label className="space-y-1 text-sm font-semibold text-[#082B4F]">
                        <span>Cap (RM)</span>
                        <TextInput
                          type="number"
                          min="0"
                          step="0.01"
                          value={managementFee.capAmount}
                          onChange={(event) =>
                            setManagementFee((current) => ({ ...current, capAmount: event.target.value }))
                          }
                        />
                      </label>
                    )}
                    <label className="space-y-1 text-sm font-semibold text-[#082B4F]">
                      <span>SST (%)</span>
                      <TextInput
                        type="number"
                        min="0"
                        step="0.01"
                        value={managementFee.sstPercent}
                        onChange={(event) =>
                          setManagementFee((current) => ({ ...current, sstPercent: event.target.value }))
                        }
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                    <label className="space-y-1 text-sm font-semibold text-[#082B4F]">
                      <span>Free period start</span>
                      <TextInput
                        type="date"
                        value={managementFee.freePeriodStart}
                        onChange={(event) =>
                          setManagementFee((current) => ({ ...current, freePeriodStart: event.target.value }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm font-semibold text-[#082B4F]">
                      <span>Free period end</span>
                      <TextInput
                        type="date"
                        value={managementFee.freePeriodEnd}
                        onChange={(event) =>
                          setManagementFee((current) => ({ ...current, freePeriodEnd: event.target.value }))
                        }
                      />
                    </label>
                    <ActionButton
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        const period = sixMonthFreePeriod(form.moveInDate);
                        if (!period) {
                          toast.error("Set the tenant move-in date before applying 6 months free.");
                          return;
                        }
                        setManagementFee((current) => ({
                          ...current,
                          freePeriodStart: period.start,
                          freePeriodEnd: period.end,
                        }));
                      }}
                    >
                      Apply 6 months free
                    </ActionButton>
                  </div>

                  <div className="rounded-lg bg-[#082F55] px-4 py-3 text-white">
                    {managementFeePreview ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm">Estimated monthly fee when rent is charged</span>
                        <strong className="text-lg text-[#F3D493]">
                          RM {managementFeePreview.base} + SST RM {managementFeePreview.sst} = RM {managementFeePreview.total}
                        </strong>
                      </div>
                    ) : (
                      <p className="text-sm">Enter the rent and fee settings to see the monthly estimate.</p>
                    )}
                    {managementFee.freePeriodEnd && (
                      <p className="mt-1 text-xs text-[#DFE9F3]">
                        First chargeable rental period begins after {managementFee.freePeriodEnd}.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {matchedApartment && form.ownerPartyId && (
            <p className="rounded-lg border border-[#9DAFC1] bg-[#F3F6F9] px-4 py-3 text-sm text-[#082B4F]">
              This room will use the existing unit&apos;s management fee setup; no duplicate fee configuration will be created.
            </p>
          )}

          {/* Partition: per-room strip. Owner + billing model stay in the form
              body above (apartment-scoped, entered once); rent/deposits/cards/
              parking and the room type are captured per room here. */}
          {mode === "PARTITIONED" && (
            <PartitionRoomStrip
              rooms={rooms}
              activeIndex={activeRoomIndex}
              // Switching or editing a room dismisses a stale per-room error so
              // it never lingers on a different room or after the field is fixed.
              onSelect={(i) => {
                setRoomErrors({});
                setActiveRoomIndex(i);
              }}
              onChange={(next) => {
                setRoomErrors({});
                setRooms(next);
              }}
              options={roomTypeOptions}
              activeRoomErrors={roomErrors}
              // Typing an existing apartment's unit code means "add rooms to
              // that apartment" — the batch endpoint appends siblings. Show what
              // it already has and lock out its taken types. This is the surface
              // that replaced the standalone "Add rooms" dialog.
              existingRooms={matchedApartment?.rooms ?? []}
            />
          )}

          <DialogFooter>
            <ActionButton
              type="submit"
              variant="primary"
              disabled={mutation.isPending || batchMutation.isPending}
            >
              {mutation.isPending || batchMutation.isPending ? "Creating…" : "Create unit"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending || batchMutation.isPending}
            >
              Cancel
            </ActionButton>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
