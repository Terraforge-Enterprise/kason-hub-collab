import type { RoomTypeOption } from "@/hooks/use-room-types";
import { UnitTypeSelect } from "@/components/unit-type-select";
import { SelectInput, TextInput } from "@/components/form-ui";
import { DepositFields } from "@/components/deposit-fields";
import { ParkingFields } from "@/components/parking-fields";
// FormField and OCCUPANCY_STATUS_OPTIONS are exported from unit-form-fields.tsx,
// NOT from form-ui (form-ui exports only TextInput / SelectInput / TextAreaInput).
import { FormField, OCCUPANCY_STATUS_OPTIONS } from "./unit-form-fields";
import { OccupancyFields, type OccupancyFieldErrors } from "./occupancy-fields";
import type {
  ApartmentRoomSummary,
  CreateUnitsBatchRoom,
} from "@/api/inventory-units-batch";
import { occupancyLabel } from "@/lib/listing-status";

export type RoomDraft = {
  unitType: string;
  rentalRate: string;
  depositMonths: string;
  utilitiesDepositMonths: string;
  accessCardQuantity: string;
  accessCardDepositPerPcs: string;
  parkingQuantity: string;
  parkingNumbers: string[];
  // Per-room occupancy (T1: UI only — T2/T3 wire this into the batch payload
  // and the create-dialog submit path respectively). Mirrors the
  // whole-unit UnitFormState occupancy fields so bridging code (bridging to
  // OccupancyFields' string-typed props) is identical on both paths.
  occupancyStatus: string;
  tenantPartyId: string | null;
  tenantName: string;
  tenantIdType: string | null;
  tenantIdNumberMasked: string | null;
  tenantPhone: string | null;
  moveInDate: string;
  moveOutDate: string;
  monthlyRent: string;
  firstMonthIsCommission: boolean;
  commissionSstBearer: "owner" | "kaen";
};

export function blankRoom(): RoomDraft {
  return {
    unitType: "",
    rentalRate: "",
    depositMonths: "",
    utilitiesDepositMonths: "",
    accessCardQuantity: "",
    accessCardDepositPerPcs: "",
    parkingQuantity: "",
    parkingNumbers: [],
    occupancyStatus: "vacant",
    tenantPartyId: null,
    tenantName: "",
    tenantIdType: null,
    tenantIdNumberMasked: null,
    tenantPhone: null,
    moveInDate: "",
    moveOutDate: "",
    monthlyRent: "",
    firstMonthIsCommission: false,
    commissionSstBearer: "owner",
  };
}

/** True when the operator has entered any per-room value (rent, either deposit,
 *  access cards, card deposit, parking, or occupancy/tenant) into a room. Used
 *  to distinguish a genuinely-blank trailing row (safe to ignore) from a row
 *  that carries data but was never given a type — whose data would otherwise
 *  be silently dropped on submit. `unitType` is deliberately excluded: this
 *  answers "is there data BESIDES the type?". A room flipped to Occupied/
 *  Reserved (or already carrying a tenant/move-in/move-out/rent) counts as
 *  data even if the type was never picked. */
export function roomHasData(r: RoomDraft): boolean {
  return (
    r.rentalRate.trim() !== "" ||
    r.depositMonths.trim() !== "" ||
    r.utilitiesDepositMonths.trim() !== "" ||
    r.accessCardQuantity.trim() !== "" ||
    r.accessCardDepositPerPcs.trim() !== "" ||
    r.parkingQuantity.trim() !== "" ||
    r.occupancyStatus !== "vacant" ||
    r.tenantPartyId !== null ||
    r.moveInDate.trim() !== "" ||
    r.moveOutDate.trim() !== "" ||
    r.monthlyRent.trim() !== ""
  );
}

/** Room types used by more than one room. The DB is unique on
 *  (apartmentId, listingType), so duplicates would 409 on submit. */
export function duplicateRoomTypes(rooms: RoomDraft[]): string[] {
  const seen = new Map<string, number>();
  for (const r of rooms) {
    if (!r.unitType) continue;
    seen.set(r.unitType, (seen.get(r.unitType) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

function formatRoomRent(amount: number | null): string {
  if (amount == null) return "—";
  return `RM ${new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

/**
 * Per-room batch payload, widened with the per-room occupancy fields.
 * `CreateUnitsBatchRoom` doesn't declare these, so the wider shape is an
 * intersection. It is a structural SUPERSET, so it flows through
 * `createUnitsBatch()` by ordinary assignability. The server's
 * `adminBatchRoomFields` accepts exactly this key set.
 */
export type RoomPayload = CreateUnitsBatchRoom & {
  occupancyStatus?: string;
  tenantPartyId?: string;
  moveInDate?: string;
  moveOutDate?: string;
  monthlyRent?: number;
  firstMonthIsCommission?: boolean;
  commissionSstBearer?: "owner" | "kaen";
};

const num = (s: string): number | undefined =>
  s === "" || Number.isNaN(Number(s)) ? undefined : Number(s);
const numInt = (s: string): number | undefined => {
  const n = num(s);
  return n === undefined ? undefined : Math.round(n);
};

/**
 * Map one RoomDraft onto the batch endpoint's per-room shape. Single
 * implementation shared by the Create dialog's Partition submit and the Edit
 * dialog's "add a room to this apartment" submit — both hit the same endpoint,
 * so the money-carrying mapping (rent, deposits, tenant, dates) must not drift
 * between them.
 *
 * occupancyStatus is a normal field, always sent; tenant/dates/rent are sent
 * ONLY when occupied, so a room left (or set back to) Vacant never carries a
 * stale tenant draft onto the wire.
 */
export function roomDraftToPayload(r: RoomDraft): RoomPayload {
  return {
    unitType: r.unitType,
    rentalRate: num(r.rentalRate),
    depositMonths: num(r.depositMonths),
    utilitiesDepositMonths: num(r.utilitiesDepositMonths),
    accessCardDepositPerPcs: num(r.accessCardDepositPerPcs),
    accessCardQuantity: numInt(r.accessCardQuantity),
    parkingQuantity: numInt(r.parkingQuantity),
    occupancyStatus: r.occupancyStatus || undefined,
    ...(r.occupancyStatus === "occupied"
      ? {
          tenantPartyId: r.tenantPartyId ?? undefined,
          moveInDate: r.moveInDate,
          moveOutDate: r.moveOutDate,
          monthlyRent: num(r.monthlyRent),
          // Commission toggles. Safe to always send on an occupied room: when the
          // flag is off the checkbox never renders, so these stay false/"owner"
          // (the server defaults) and the guard sees no change.
          firstMonthIsCommission: r.firstMonthIsCommission,
          commissionSstBearer: r.commissionSstBearer,
        }
      : {}),
  };
}

/**
 * The editable body for ONE room: type, rent, deposits, parking, occupancy and
 * tenant. Rendered by PartitionRoomStrip for the active tab, and by the Edit
 * dialog's Add-room panel. Kept as a separate component so both surfaces
 * capture exactly the same fields — a room added from Edit must be indis-
 * tinguishable from a room added at Create.
 */
export function RoomDraftFields({
  room,
  onChange,
  options,
  excludeNames = [],
  errors = {},
}: {
  room: RoomDraft;
  onChange: (patch: Partial<RoomDraft>) => void;
  options: RoomTypeOption[];
  /** Room types already taken — by a sibling draft or a saved sibling. */
  excludeNames?: string[];
  errors?: OccupancyFieldErrors;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Room type">
          <UnitTypeSelect
            value={room.unitType}
            onChange={(next) => onChange({ unitType: next })}
            options={options}
            lockMode="PARTITIONED"
            excludeNames={excludeNames}
          />
        </FormField>
        <FormField label="Rent (RM/mo)">
          <TextInput
            aria-label="Rent (RM/mo)"
            type="number"
            min={0}
            step="0.01"
            value={room.rentalRate}
            onChange={(e) => onChange({ rentalRate: e.target.value })}
          />
        </FormField>
      </div>

      <DepositFields
        rentalRate={room.rentalRate === "" ? null : Number(room.rentalRate)}
        depositMonths={room.depositMonths === "" ? null : Number(room.depositMonths)}
        utilitiesDepositMonths={
          room.utilitiesDepositMonths === "" ? null : Number(room.utilitiesDepositMonths)
        }
        accessCardDepositPerPcs={
          room.accessCardDepositPerPcs === "" ? null : Number(room.accessCardDepositPerPcs)
        }
        accessCardQuantity={
          room.accessCardQuantity === "" ? null : Number(room.accessCardQuantity)
        }
        onChange={(patch) => {
          const next: Partial<RoomDraft> = {};
          if (patch.depositMonths !== undefined) {
            next.depositMonths = patch.depositMonths === null ? "" : String(patch.depositMonths);
          }
          if (patch.utilitiesDepositMonths !== undefined) {
            next.utilitiesDepositMonths =
              patch.utilitiesDepositMonths === null ? "" : String(patch.utilitiesDepositMonths);
          }
          if (patch.accessCardDepositPerPcs !== undefined) {
            next.accessCardDepositPerPcs =
              patch.accessCardDepositPerPcs === null ? "" : String(patch.accessCardDepositPerPcs);
          }
          if (patch.accessCardQuantity !== undefined) {
            next.accessCardQuantity =
              patch.accessCardQuantity === null ? "" : String(patch.accessCardQuantity);
          }
          onChange(next);
        }}
      />

      <ParkingFields
        parkingQuantity={room.parkingQuantity === "" ? null : Number(room.parkingQuantity)}
        parkingNumbers={room.parkingNumbers}
        onChange={(patch) =>
          onChange({
            parkingQuantity: patch.parkingQuantity === null ? "" : String(patch.parkingQuantity),
            parkingNumbers: patch.parkingNumbers,
          })
        }
      />

      <FormField label="Occupancy status" className="max-w-xs">
        <SelectInput
          aria-label="Occupancy status"
          value={room.occupancyStatus}
          onChange={(e) => onChange({ occupancyStatus: e.target.value })}
        >
          {OCCUPANCY_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectInput>
      </FormField>

      <OccupancyFields
        occupancyStatus={room.occupancyStatus}
        tenantPartyId={room.tenantPartyId}
        tenantName={room.tenantName}
        tenantIdType={room.tenantIdType}
        tenantIdNumberMasked={room.tenantIdNumberMasked}
        tenantPhone={room.tenantPhone}
        moveInDate={room.moveInDate}
        moveOutDate={room.moveOutDate}
        monthlyRent={room.monthlyRent}
        firstMonthIsCommission={room.firstMonthIsCommission}
        commissionSstBearer={room.commissionSstBearer}
        onFirstMonthIsCommissionChange={(next) => onChange({ firstMonthIsCommission: next })}
        onCommissionSstBearerChange={(next) => onChange({ commissionSstBearer: next })}
        // createUnitService's OCCUPANCY_RENT_REQUIRED guard is not flag-gated
        // on the single-unit path, and the batch loop ports the same guard
        // verbatim per room — always show the rent input so the admin can
        // satisfy a 400 they'd otherwise have no visible field to fix.
        showRent
        onSelectTenant={(t) =>
          onChange({
            tenantPartyId: t.id,
            tenantName: t.displayName,
            tenantIdType: t.idType,
            tenantIdNumberMasked: t.idNumberMasked,
            tenantPhone: t.formattedPhone ?? t.primaryPhone,
          })
        }
        onClearTenant={() =>
          onChange({
            tenantPartyId: null,
            tenantName: "",
            tenantIdType: null,
            tenantIdNumberMasked: null,
            tenantPhone: null,
          })
        }
        onChange={(patch) => onChange(patch)}
        errors={errors}
      />
    </>
  );
}

export function PartitionRoomStrip({
  rooms,
  activeIndex,
  onSelect,
  onChange,
  options,
  activeRoomErrors,
  existingRooms = [],
}: {
  rooms: RoomDraft[];
  activeIndex: number;
  onSelect: (i: number) => void;
  onChange: (next: RoomDraft[]) => void;
  options: RoomTypeOption[];
  // Occupancy field errors for the ACTIVE room only (the strip renders one
  // OccupancyFields at a time). Wired by the create dialog's pre-submit
  // occupancy check + batch onError so a per-room 400 surfaces on the field
  // that caused it instead of vanishing. Optional so the strip stays usable
  // standalone (defaults to no errors).
  activeRoomErrors?: OccupancyFieldErrors;
  // Rooms this apartment ALREADY has on the server, when the operator typed a
  // unit code matching an existing apartment. Two jobs: show what's there, and
  // exclude those types from the picker. The DB is unique on
  // (apartmentId, listingType), so picking one would 409 on submit — and the
  // within-batch `duplicateRoomTypes` check below cannot see them.
  existingRooms?: ApartmentRoomSummary[];
}) {
  const active = rooms[activeIndex] ?? blankRoom();
  const dups = duplicateRoomTypes(rooms);
  const existingTypes = existingRooms.map((r) => r.unitType).filter(Boolean);

  const setActive = (patch: Partial<RoomDraft>) =>
    onChange(rooms.map((r, i) => (i === activeIndex ? { ...r, ...patch } : r)));

  const removeRoom = (i: number) => {
    const next = rooms.filter((_, idx) => idx !== i);
    onChange(next);
    // Keep the selection on a surviving room: shift down if we removed a
    // tab before the active one, otherwise clamp into the shorter array.
    onSelect(activeIndex > i ? activeIndex - 1 : Math.min(activeIndex, next.length - 1));
  };

  return (
    <div className="space-y-3">
      {existingRooms.length > 0 && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2">
          <p className="text-xs font-medium text-[var(--text-primary)]">
            Existing rooms in this apartment
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {existingRooms.map((r) => (
              <li key={r.id} className="text-xs text-[var(--text-secondary)]">
                <span className="font-medium capitalize">{r.unitType}</span>{" "}
                {formatRoomRent(r.rentalRate)} · {occupancyLabel(r.occupancyStatus ?? "vacant")}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            One room per type — these types are excluded from the picker below.
          </p>
        </div>
      )}

      {/* The client calls this element the "header" (formerly "bar"). */}
      <div
        role="tablist"
        aria-label="Rooms"
        className="flex flex-wrap items-center gap-1 border-b border-[var(--card-border)]"
      >
        {rooms.map((r, i) => (
          <span
            key={i}
            className={`-mb-px inline-flex items-center rounded-t-md border-x border-t text-sm ${
              i === activeIndex
                ? "border-[var(--card-border)] bg-[var(--card-bg)] font-medium"
                : "border-transparent text-[var(--text-secondary)]"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={i === activeIndex}
              aria-current={i === activeIndex}
              onClick={() => onSelect(i)}
              className="px-3 py-1.5"
            >
              {r.unitType || `Room ${i + 1}`}
            </button>
            {rooms.length > 1 && (
              <button
                type="button"
                aria-label={`Remove room ${i + 1}`}
                onClick={() => removeRoom(i)}
                className="pr-2 pl-0.5 text-[var(--text-secondary)] hover:text-[var(--danger)]"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          onClick={() => {
            onChange([...rooms, blankRoom()]);
            onSelect(rooms.length);
          }}
          className="ml-2 rounded-md px-2 py-1 text-sm text-[var(--primary)]"
        >
          + New Room
        </button>
      </div>

      {dups.length > 0 && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          Each room needs a distinct type. Duplicated: {dups.join(", ")}.
        </p>
      )}

      <RoomDraftFields
        room={active}
        onChange={setActive}
        options={options}
        excludeNames={[
          ...rooms
            .filter((_, i) => i !== activeIndex)
            .map((r) => r.unitType)
            .filter(Boolean),
          // Types already taken by a saved sibling. Without these the operator
          // can pick one and only learn on the 409.
          ...existingTypes,
        ]}
        // Per-room error threading: the create dialog's pre-submit occupancy
        // check + batch onError feed the active room's field errors here, so an
        // Occupied room missing tenant/dates/rent is flagged on the offending
        // field instead of failing silently.
        errors={activeRoomErrors ?? {}}
      />
    </div>
  );
}
