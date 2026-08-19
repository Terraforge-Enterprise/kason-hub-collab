// Portal page — agent edits an existing rental Unit they submitted, typically
// in response to an admin "Needs amendment" note. PATCHes via
// updatePortalUnit; the server resolves the right write path based on state:
//   - pending / needs_amendment → direct row update (this page's target)
//   - approved / pending_changes → queued in pendingChanges (separate UX)
//   - rejected / withdrawn → 409 (page should not be reachable for these)
//
// Single-row edit only — apartment-level fan-out lives on the create page's
// batch endpoint (with the ownership gate). Edits here change ONLY this row;
// if apartment-shared fields drift from siblings, fix via the create flow.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Building2 } from "lucide-react";
import { UnitTypeSelect } from "@/components/unit-type-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { DepositFields } from "@/components/deposit-fields";
import { ParkingFields } from "@/components/parking-fields";
import { useRoomTypes } from "@/hooks/use-room-types";
import {
  listOwnPortalUnits,
  updatePortalUnit,
  type PortalOwnUnit,
  type UpdatePortalUnitPayload,
} from "@/api/portal-inventory";

// After the three-table refactor, status is first-class on the submission
// row. The legacy "pending_changes" bucket no longer exists — amendments
// to approved listings are filed as separate UnitSubmission rows with
// parentListingId set, and they live in the regular pending/needs_amendment
// flow.
type EditableState = "pending" | "needs_amendment";
type Status = "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";

function isEditable(s: Status): s is EditableState {
  return s === "pending" || s === "needs_amendment";
}

/**
 * Extract typed listing-offer fields from `submittedPayload.listing`. Reads
 * are defensive — missing or non-numeric fields surface as undefined so the
 * form can render an empty input.
 */
function readListingPayload(u: PortalOwnUnit): {
  rentalRate?: number;
  depositMonths?: number;
  utilitiesDepositMonths?: number;
  accessCardDepositPerPcs?: number;
  accessCardQuantity?: number;
  parkingQuantity?: number;
  parkingNumbers?: string[];
} {
  const payload = (u.submittedPayload ?? {}) as {
    listing?: Record<string, unknown>;
  };
  const listing = (payload.listing ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    rentalRate: num(listing.rentalRate),
    depositMonths: num(listing.depositMonths),
    utilitiesDepositMonths: num(listing.utilitiesDepositMonths),
    accessCardDepositPerPcs: num(listing.accessCardDepositPerPcs),
    accessCardQuantity: num(listing.accessCardQuantity),
    parkingQuantity: num(listing.parkingQuantity),
    parkingNumbers: Array.isArray(listing.parkingNumbers)
      ? (listing.parkingNumbers as string[])
      : undefined,
  };
}

function readApartmentSharedPayload(u: PortalOwnUnit): {
  bedrooms?: number;
  bathrooms?: number;
  floor?: number;
  floorArea?: number;
  description?: string;
} {
  const payload = (u.submittedPayload ?? {}) as {
    apartmentShared?: Record<string, unknown>;
  };
  const shared = (payload.apartmentShared ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    bedrooms: num(shared.bedrooms),
    bathrooms: num(shared.bathrooms),
    floor: num(shared.floor),
    floorArea: num(shared.floorArea),
    description:
      typeof shared.publishedDescription === "string"
        ? (shared.publishedDescription as string)
        : undefined,
  };
}

// Form state — mirrors UpdatePortalUnitPayload but uses string-y inputs for
// numeric fields so empty inputs stay empty (not coerced to 0).
type FormState = {
  unitType: string;
  rentalRate: number | undefined;
  bedrooms: number | undefined;
  bathrooms: number | undefined;
  floor: number | undefined;
  floorArea: number | undefined;
  depositMonths: number | undefined;
  utilitiesDepositMonths: number | undefined;
  accessCardDepositPerPcs: number | undefined;
  accessCardQuantity: number | undefined;
  parkingQuantity: number | undefined;
  parkingNumbers: string[];
  description: string;
};

function unitToForm(u: PortalOwnUnit): FormState {
  // Read prior values from submittedPayload — that's where the agent's
  // commercial offer + apartment-shared candidates live for both pending
  // submissions and amendments.
  const listing = readListingPayload(u);
  const shared = readApartmentSharedPayload(u);
  return {
    unitType: u.unitType,
    rentalRate: listing.rentalRate,
    bedrooms: shared.bedrooms,
    bathrooms: shared.bathrooms,
    floor: shared.floor,
    floorArea: shared.floorArea,
    depositMonths: listing.depositMonths,
    utilitiesDepositMonths: listing.utilitiesDepositMonths,
    accessCardDepositPerPcs: listing.accessCardDepositPerPcs,
    accessCardQuantity: listing.accessCardQuantity,
    parkingQuantity: listing.parkingQuantity,
    parkingNumbers: listing.parkingNumbers ?? [],
    description: shared.description ?? "",
  };
}

// Build the PATCH payload. Only include fields the agent actually filled in,
// to avoid clobbering server-only state with `undefined`. Numeric `undefined`
// → field omitted; arrays / strings always sent.
function formToPayload(form: FormState): UpdatePortalUnitPayload {
  const out: UpdatePortalUnitPayload = {
    unitType: form.unitType,
    parkingNumbers: form.parkingNumbers,
  };
  if (form.rentalRate !== undefined) out.rentalRate = form.rentalRate;
  if (form.bedrooms !== undefined) out.bedrooms = form.bedrooms;
  if (form.bathrooms !== undefined) out.bathrooms = form.bathrooms;
  if (form.floor !== undefined) out.floor = form.floor;
  if (form.floorArea !== undefined) out.floorArea = form.floorArea;
  if (form.depositMonths !== undefined) out.depositMonths = form.depositMonths;
  if (form.utilitiesDepositMonths !== undefined) out.utilitiesDepositMonths = form.utilitiesDepositMonths;
  if (form.accessCardDepositPerPcs !== undefined) out.accessCardDepositPerPcs = form.accessCardDepositPerPcs;
  if (form.accessCardQuantity !== undefined) out.accessCardQuantity = form.accessCardQuantity;
  if (form.parkingQuantity !== undefined) out.parkingQuantity = form.parkingQuantity;
  if (form.description.trim()) out.description = form.description.trim();
  return out;
}

function parseNonNegative(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export default function PortalInventoryEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Reuse the My Uploads cache so we don't re-fetch the whole list when the
  // agent navigates from there. Same queryKey as my-uploads-page.
  const ownUnitsQuery = useQuery({
    queryKey: ["portal-my-uploads"],
    queryFn: listOwnPortalUnits,
  });

  const unit = useMemo(
    () => ownUnitsQuery.data?.find((u) => u.id === id) ?? null,
    [ownUnitsQuery.data, id],
  );

  const [form, setForm] = useState<FormState | null>(null);

  // Hydrate form once the unit is loaded. Re-hydrate if the unit id changes
  // (e.g., user back/forward navigation between two amend pages).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (unit) setForm(unitToForm(unit));
  }, [unit]);

  // Unit-type options from org's RoomType catalog (admin configures these).
  const roomTypesQuery = useRoomTypes();
  const roomTypesData = useMemo(
    () => (roomTypesQuery.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [roomTypesQuery.data],
  );

  const update = useMutation({
    mutationFn: (payload: UpdatePortalUnitPayload) => updatePortalUnit(id!, payload),
    onSuccess: () => {
      toast.success("Amendment submitted — admin will re-review.");
      // Invalidate so My Uploads + the detail page reflect the new values
      // (the row stays in needs_amendment until admin re-acts).
      void queryClient.invalidateQueries({ queryKey: ["portal-my-uploads"] });
      void queryClient.invalidateQueries({ queryKey: ["portal-listing", id] });
      navigate("/portal/my-uploads");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to submit amendment");
    },
  });

  if (ownUnitsQuery.isLoading || (unit && !form)) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  if (!unit) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              This unit isn&rsquo;t in your uploads, or the link is invalid.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = unit.submissionState as Status;
  if (!isEditable(status)) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-8 space-y-2 text-center">
            <p className="text-sm font-semibold text-foreground">
              This unit can&rsquo;t be amended in this state.
            </p>
            <p className="text-xs text-muted-foreground">
              Status: <span className="font-medium">{status}</span>. Amendments
              are only available while the submission is pending or marked
              &ldquo;Needs amendment&rdquo; by an admin.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const f = form!; // form is hydrated whenever unit exists (effect above)

  function patch(p: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...p } : prev));
  }

  const canSubmit = f.unitType.trim() !== "" && !update.isPending;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <BackLink />

      <div>
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <Building2 className="h-6 w-6 text-primary" /> Amend submission
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {unit.property?.name ?? "Unknown property"}{" "}
          <span className="font-mono">· {unit.unitCode}</span>
          {unit.unitType && <> · <span className="capitalize">{unit.unitType}</span></>}
        </p>
      </div>

      {/* Admin's amendment note, surfaced prominently. Only shown for
          needs_amendment — the pending bucket has no admin note yet. */}
      {status === "needs_amendment" && unit.amendmentNote && (
        <Callout variant="warning" title="Admin requested changes">
          {unit.amendmentNote.replace(/^REJECTED:\s*/, "")}
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Room details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-muted-foreground">Room type *</span>
              <UnitTypeSelect
                value={f.unitType}
                onChange={(next) => patch({ unitType: next })}
                options={roomTypesData}
                lockMode={null}
                disabled={roomTypesQuery.isLoading}
                placeholder={
                  roomTypesQuery.isLoading
                    ? "Loading…"
                    : roomTypesData.length === 0
                      ? "No unit types configured — ask admin"
                      : "Pick a room type…"
                }
                className="mt-1 w-full"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Rent (RM/mo)</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={f.rentalRate ?? ""}
                onChange={(e) => patch({ rentalRate: parseNonNegative(e.target.value) })}
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">Bedrooms</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={f.bedrooms ?? ""}
                onChange={(e) => patch({ bedrooms: parseNonNegative(e.target.value) })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Bathrooms</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={f.bathrooms ?? ""}
                onChange={(e) => patch({ bathrooms: parseNonNegative(e.target.value) })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">Floor area (sqft)</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={f.floorArea ?? ""}
                onChange={(e) => patch({ floorArea: parseNonNegative(e.target.value) })}
              />
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deposits & access</CardTitle>
        </CardHeader>
        <CardContent>
          <DepositFields
            rentalRate={f.rentalRate ?? null}
            depositMonths={f.depositMonths ?? null}
            utilitiesDepositMonths={f.utilitiesDepositMonths ?? null}
            accessCardDepositPerPcs={f.accessCardDepositPerPcs ?? null}
            accessCardQuantity={f.accessCardQuantity ?? null}
            onChange={(p) =>
              patch({
                ...(p.depositMonths !== undefined && { depositMonths: p.depositMonths ?? undefined }),
                ...(p.utilitiesDepositMonths !== undefined && {
                  utilitiesDepositMonths: p.utilitiesDepositMonths ?? undefined,
                }),
                ...(p.accessCardDepositPerPcs !== undefined && {
                  accessCardDepositPerPcs: p.accessCardDepositPerPcs ?? undefined,
                }),
                ...(p.accessCardQuantity !== undefined && {
                  accessCardQuantity: p.accessCardQuantity ?? undefined,
                }),
              })
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Parking</CardTitle>
        </CardHeader>
        <CardContent>
          <ParkingFields
            parkingQuantity={f.parkingQuantity ?? null}
            parkingNumbers={f.parkingNumbers}
            onChange={(p) =>
              patch({
                parkingQuantity: p.parkingQuantity ?? undefined,
                parkingNumbers: p.parkingNumbers,
              })
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Description</CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            value={f.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Sunny corner unit with panoramic city view…"
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            This update applies to this room only. To edit shared apartment
            fields across every room, use Add new and pick the existing
            apartment.
          </p>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="gold"
          onClick={() => update.mutate(formToPayload(f))}
          disabled={!canSubmit}
        >
          {update.isPending ? "Submitting…" : "Submit amendment"}
        </Button>
        <Button variant="ghost" onClick={() => navigate(-1)} disabled={update.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <a
      href="/portal/my-uploads"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to My uploads
    </a>
  );
}
