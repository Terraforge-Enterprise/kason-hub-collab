/**
 * Detail drawer for a single SalesUnit.
 *
 * Loads the unit + transition history. Manager+ may edit financials and
 * transition the renovation status; editor sees read-only fields. Server
 * still re-checks every PATCH so the UI gate is purely cosmetic.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Building2, ExternalLink, Hammer, History, X } from "lucide-react";
import { toast } from "sonner";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import {
  getSalesUnit,
  listRenovationTransitions,
  setRenovationStatus,
  updateSalesUnit,
  type RenovationStatus,
  type SalesUnit,
} from "@/api/sales";
import { AgentSelect } from "@/pages/inventory/unit-form-fields";

const STATUS_LABELS: Record<RenovationStatus, string> = {
  not_started: "Not Started",
  on_going: "On Going",
  completed: "Completed",
};

const STATUS_VARIANT: Record<RenovationStatus, "rose" | "amber" | "emerald"> = {
  not_started: "rose",
  on_going: "amber",
  completed: "emerald",
};

function formatRM(value: number | null | undefined): string {
  if (value == null) return "—";
  return `RM ${value.toLocaleString("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function inputDateToIso(value: string): string | null {
  if (!value) return null;
  // Treat the local date as UTC midnight — matches what the seed/portal
  // does and keeps the day visible to operators in MYT consistent.
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

interface DrawerProps {
  unitId: string;
  canEdit: boolean;
  projectName: (id: string) => string;
  onClose: () => void;
}

export function SalesUnitDrawer({
  unitId,
  canEdit,
  projectName,
  onClose,
}: DrawerProps) {
  const queryClient = useQueryClient();

  const unitQuery = useQuery({
    queryKey: ["sales", "unit", unitId],
    queryFn: () => getSalesUnit(unitId),
    enabled: !!unitId,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  const transitionsQuery = useQuery({
    queryKey: ["sales", "unit", unitId, "transitions"],
    queryFn: () => listRenovationTransitions(unitId),
    enabled: !!unitId,
  });

  if (unitQuery.isLoading) {
    return (
      <div className="space-y-4 p-2 animate-pulse">
        <div className="h-6 w-2/3 bg-muted rounded" />
        <div className="h-32 bg-muted rounded-xl" />
        <div className="h-48 bg-muted rounded-xl" />
      </div>
    );
  }

  if (unitQuery.isError || !unitQuery.data) {
    const notFound =
      unitQuery.error instanceof ApiError && unitQuery.error.status === 404;
    return (
      <div className="space-y-3 p-4">
        <SheetHeader>
          <SheetTitle>Unable to load unit</SheetTitle>
        </SheetHeader>
        <p className="text-sm text-muted-foreground">
          {notFound
            ? "This sales unit no longer exists."
            : "Failed to load sales unit details. Please try again."}
        </p>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }

  const unit = unitQuery.data.data;
  const transitions = transitionsQuery.data?.data ?? [];

  return (
    <DrawerBody
      unit={unit}
      transitions={transitions}
      canEdit={canEdit}
      projectName={projectName(unit.projectId)}
      onClose={onClose}
      onMutated={() => {
        queryClient.invalidateQueries({ queryKey: ["sales", "unit", unitId] });
        queryClient.invalidateQueries({
          queryKey: ["sales", "unit", unitId, "transitions"],
        });
        queryClient.invalidateQueries({ queryKey: ["sales", "units"] });
      }}
    />
  );
}

interface DrawerBodyProps {
  unit: SalesUnit;
  transitions: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    changedAt: string;
    note: string | null;
    changedById: string;
  }>;
  canEdit: boolean;
  projectName: string;
  onClose: () => void;
  onMutated: () => void;
}

function DrawerBody({
  unit,
  transitions,
  canEdit,
  projectName,
  onClose,
  onMutated,
}: DrawerBodyProps) {
  // ─── Renovation editor state ───
  // Latest progress isn't joined onto the unit row yet — we infer the
  // current status from the most recent transition; if there are no
  // transitions, we treat the unit as not_started (matches the upsert
  // semantics in the API).
  const inferredStatus: RenovationStatus = useMemo(() => {
    if (transitions.length === 0) return "not_started";
    // API returns transitions newest-first (orderBy changedAt desc).
    const latest = transitions[0];
    const candidate = latest?.toStatus;
    if (
      candidate === "not_started" ||
      candidate === "on_going" ||
      candidate === "completed"
    ) {
      return candidate;
    }
    return "not_started";
  }, [transitions]);

  const [renoStatus, setRenoStatus] = useState<RenovationStatus>(inferredStatus);
  const [startDate, setStartDate] = useState<string>("");
  const [expectedCompletion, setExpectedCompletion] = useState<string>("");
  const [actualCompletion, setActualCompletion] = useState<string>("");
  const [renoNote, setRenoNote] = useState<string>("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    setRenoStatus(inferredStatus);
  }, [inferredStatus]);

  // ─── Edit financials state ───
  const [isEditingFinance, setIsEditingFinance] = useState(false);
  const [purchasePrice, setPurchasePrice] = useState<string>(
    String(unit.purchasePrice ?? ""),
  );
  const [expectedRental, setExpectedRental] = useState<string>(
    unit.expectedRental != null ? String(unit.expectedRental) : "",
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    setPurchasePrice(String(unit.purchasePrice ?? ""));
    setExpectedRental(unit.expectedRental != null ? String(unit.expectedRental) : "");
  }, [unit.purchasePrice, unit.expectedRental]);

  // ─── Edit details state (PR5) ───
  // The PATCH endpoint accepts unitNumber, purpose, bedrooms, bathrooms,
  // parkingLots, inChargePartyId — all of which were previously not
  // editable from the admin drawer (you'd have to ask the agent to
  // resubmit). The most operationally important is `inChargePartyId`,
  // which determines who owns the unit once it's promoted to rental.
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [unitNumber, setUnitNumber] = useState<string>(unit.unitNumber);
  const [purpose, setPurpose] = useState<SalesUnit["purpose"]>(unit.purpose);
  const [bedrooms, setBedrooms] = useState<string>(String(unit.bedrooms));
  const [bathrooms, setBathrooms] = useState<string>(String(unit.bathrooms));
  const [parkingLots, setParkingLots] = useState<string>(String(unit.parkingLots));
  const [inChargePartyId, setInChargePartyId] = useState<string | null>(
    unit.inChargePartyId,
  );
  // Display name is purely for the typeahead chip — server doesn't store
  // it (just the FK). Initialize empty; AgentSelect will populate as the
  // operator picks. Future improvement: hydrate from the joined Party row.
  const [inChargeName, setInChargeName] = useState<string>("");

  useEffect(() => {
    // Re-sync local form state when the upstream unit row changes (e.g.
    // after another mutation) — same pattern the financials section uses.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    setUnitNumber(unit.unitNumber);
    setPurpose(unit.purpose);
    setBedrooms(String(unit.bedrooms));
    setBathrooms(String(unit.bathrooms));
    setParkingLots(String(unit.parkingLots));
    setInChargePartyId(unit.inChargePartyId);
  }, [
    unit.unitNumber,
    unit.purpose,
    unit.bedrooms,
    unit.bathrooms,
    unit.parkingLots,
    unit.inChargePartyId,
  ]);

  const detailsMutation = useMutation({
    mutationFn: () => {
      const beds = Number(bedrooms);
      const baths = Number(bathrooms);
      const parking = Number(parkingLots);
      if (!Number.isFinite(beds)) throw new Error("Bedrooms must be a number.");
      if (!Number.isFinite(baths)) throw new Error("Bathrooms must be a number.");
      if (!Number.isFinite(parking) || parking < 0) {
        throw new Error("Parking lots must be a non-negative number.");
      }
      if (!unitNumber.trim()) throw new Error("Unit number is required.");
      return updateSalesUnit(unit.id, {
        unitNumber: unitNumber.trim(),
        purpose,
        bedrooms: beds,
        bathrooms: baths,
        parkingLots: parking,
        inChargePartyId,
      });
    },
    onSuccess: () => {
      toast.success("Unit details updated.");
      setIsEditingDetails(false);
      onMutated();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update unit details.");
    },
  });

  const renovationMutation = useMutation({
    mutationFn: () =>
      setRenovationStatus(unit.id, {
        status: renoStatus,
        startDate: startDate ? inputDateToIso(startDate) : undefined,
        expectedCompletion: expectedCompletion
          ? inputDateToIso(expectedCompletion)
          : undefined,
        actualCompletion: actualCompletion
          ? inputDateToIso(actualCompletion)
          : undefined,
        note: renoNote.trim() || undefined,
      }),
    onSuccess: (res) => {
      const promoted = res.data.promotedUnitId;
      if (promoted) {
        toast.success(
          "Renovation marked completed — unit promoted to rental inventory.",
        );
      } else {
        toast.success("Renovation status updated.");
      }
      setRenoNote("");
      onMutated();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update renovation status.");
    },
  });

  const financeMutation = useMutation({
    mutationFn: () => {
      const purchase = Number(purchasePrice);
      const rental = expectedRental.trim() === "" ? null : Number(expectedRental);
      if (!Number.isFinite(purchase) || purchase < 0) {
        throw new Error("Purchase price must be a non-negative number.");
      }
      if (rental !== null && (!Number.isFinite(rental) || rental < 0)) {
        throw new Error("Expected rental must be a non-negative number.");
      }
      return updateSalesUnit(unit.id, {
        purchasePrice: purchase,
        expectedRental: rental,
      });
    },
    onSuccess: () => {
      toast.success("Financials updated.");
      setIsEditingFinance(false);
      onMutated();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update financials.");
    },
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          {projectName} · {unit.unitNumber}
        </SheetTitle>
        <SheetDescription>
          Sales entry detail — submitted on {unit.salesDate.slice(0, 10)} · sourcing{" "}
          {unit.sourcingApproved ? "approved" : "pending"}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-4 mt-4">
        {/* Identity row */}
        <Card className="bg-background/40 border-border/50">
          <CardContent className="p-4 grid grid-cols-2 gap-3 text-sm">
            <Field label="Purpose">
              <Badge variant={unit.purpose === "rent" ? "sky" : "outline"}>
                {unit.purpose === "rent" ? "rent" : "own stay"}
              </Badge>
            </Field>
            <Field label="Sourcing">
              {unit.sourcingApproved ? (
                <Badge variant="emerald">Approved</Badge>
              ) : (
                <Badge variant="amber">Pending review</Badge>
              )}
            </Field>
            <Field label="Layout">
              <span className="font-medium">
                {unit.bedrooms === -1 ? "Studio" : `${unit.bedrooms}BR`} ·{" "}
                {unit.bathrooms}BA
              </span>
            </Field>
            <Field label="Parking">
              <span className="font-medium">{unit.parkingLots}</span>
            </Field>
            {unit.amendmentNotes && (
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground mb-1">Amendment notes</p>
                <p className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-3 py-2 whitespace-pre-wrap">
                  {unit.amendmentNotes}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Financial row */}
        <Card className="bg-background/40 border-border/50">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                Financials
              </h3>
              {canEdit && !isEditingFinance && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingFinance(true)}
                >
                  Edit
                </Button>
              )}
            </div>

            {!isEditingFinance ? (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Purchase price">
                  <span className="font-semibold tabular-nums">
                    {formatRM(unit.purchasePrice)}
                  </span>
                </Field>
                <Field label="Expected rental">
                  <span className="font-semibold tabular-nums">
                    {unit.expectedRental != null
                      ? `${formatRM(unit.expectedRental)} / month`
                      : "—"}
                  </span>
                </Field>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Purchase price (RM)</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={purchasePrice}
                      onChange={(e) => setPurchasePrice(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm tabular-nums"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Expected rental / mo (RM)</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={expectedRental}
                      onChange={(e) => setExpectedRental(e.target.value)}
                      placeholder="(optional)"
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm tabular-nums"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="gold"
                    size="sm"
                    onClick={() => financeMutation.mutate()}
                    disabled={financeMutation.isPending}
                  >
                    {financeMutation.isPending ? "Saving…" : "Save financials"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setIsEditingFinance(false);
                      setPurchasePrice(String(unit.purchasePrice ?? ""));
                      setExpectedRental(
                        unit.expectedRental != null ? String(unit.expectedRental) : "",
                      );
                    }}
                    disabled={financeMutation.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Unit details — manager+ can correct unit metadata + assign the
            agent who'll own the unit when it's promoted to rental. */}
        <Card className="bg-background/40 border-border/50">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                Unit details
              </h3>
              {canEdit && !isEditingDetails && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingDetails(true)}
                >
                  Edit
                </Button>
              )}
            </div>
            {!isEditingDetails ? (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Unit number">
                  <span className="font-medium">{unit.unitNumber}</span>
                </Field>
                <Field label="Purpose">
                  <span className="font-medium capitalize">
                    {unit.purpose === "rent" ? "Rent" : "Own stay"}
                  </span>
                </Field>
                <Field label="Bedrooms">
                  <span className="font-medium">
                    {unit.bedrooms === -1 ? "Studio" : unit.bedrooms}
                  </span>
                </Field>
                <Field label="Bathrooms">
                  <span className="font-medium">{unit.bathrooms}</span>
                </Field>
                <Field label="Parking">
                  <span className="font-medium">{unit.parkingLots}</span>
                </Field>
                <Field label="In charge">
                  <span className="font-mono text-xs">
                    {unit.inChargePartyId
                      ? `${unit.inChargePartyId.slice(0, 8)}…`
                      : "—"}
                  </span>
                </Field>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Unit number</span>
                    <input
                      type="text"
                      value={unitNumber}
                      onChange={(e) => setUnitNumber(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Purpose</span>
                    <select
                      value={purpose}
                      onChange={(e) =>
                        setPurpose(e.target.value as SalesUnit["purpose"])
                      }
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    >
                      <option value="rent">Rent</option>
                      <option value="own_stay">Own stay</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Bedrooms</span>
                    <select
                      value={bedrooms}
                      onChange={(e) => setBedrooms(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    >
                      <option value="-1">Studio</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4+</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Bathrooms</span>
                    <select
                      value={bathrooms}
                      onChange={(e) => setBathrooms(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3+</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Parking</span>
                    <input
                      type="number"
                      min={0}
                      value={parkingLots}
                      onChange={(e) => setParkingLots(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm tabular-nums"
                    />
                  </label>
                  <div className="block">
                    <span className="text-xs text-muted-foreground">In charge</span>
                    <div className="mt-1">
                      <AgentSelect
                        value={inChargePartyId}
                        displayName={inChargeName}
                        onSelect={(id, name) => {
                          setInChargePartyId(id);
                          setInChargeName(name);
                        }}
                        onClear={() => {
                          setInChargePartyId(null);
                          setInChargeName("");
                        }}
                        placeholder="Search agent or admin"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="gold"
                    size="sm"
                    onClick={() => detailsMutation.mutate()}
                    disabled={detailsMutation.isPending}
                  >
                    {detailsMutation.isPending ? "Saving…" : "Save details"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setIsEditingDetails(false);
                      setUnitNumber(unit.unitNumber);
                      setPurpose(unit.purpose);
                      setBedrooms(String(unit.bedrooms));
                      setBathrooms(String(unit.bathrooms));
                      setParkingLots(String(unit.parkingLots));
                      setInChargePartyId(unit.inChargePartyId);
                      setInChargeName("");
                    }}
                    disabled={detailsMutation.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Renovation status */}
        <Card className="bg-background/40 border-border/50">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground flex items-center gap-2">
                <Hammer className="h-3.5 w-3.5" /> Renovation
              </h3>
              <Badge variant={STATUS_VARIANT[inferredStatus]}>
                {STATUS_LABELS[inferredStatus]}
              </Badge>
            </div>

            {!canEdit ? (
              <p className="text-xs text-muted-foreground italic">
                Read-only — manager role required to change renovation status.
              </p>
            ) : (
              <div className="space-y-3">
                <div>
                  <span className="text-xs text-muted-foreground">Set status</span>
                  <div className="mt-1 flex items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5 w-fit">
                    {(["not_started", "on_going", "completed"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setRenoStatus(s)}
                        className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                          renoStatus === s
                            ? "bg-[var(--gold)]/15 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {STATUS_LABELS[s]}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground italic">
                  Dates left blank will clear on save — re-enter known values
                  before changing status.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Start date</span>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Expected completion</span>
                    <input
                      type="date"
                      value={expectedCompletion}
                      onChange={(e) => setExpectedCompletion(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Actual completion</span>
                    <input
                      type="date"
                      value={actualCompletion}
                      onChange={(e) => setActualCompletion(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs text-muted-foreground">Note (optional)</span>
                  <textarea
                    value={renoNote}
                    onChange={(e) => setRenoNote(e.target.value)}
                    rows={2}
                    placeholder="Why this transition?"
                    className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
                  />
                </label>

                {renoStatus === "completed" && unit.purpose === "rent" && !unit.promotedUnitId && (
                  <p className="text-xs text-amber-400 italic">
                    Marking completed will auto-promote this unit into rental
                    inventory (purpose=rent).
                  </p>
                )}
                {unit.promotedUnitId && (
                  <p className="text-xs text-emerald-400 flex items-center gap-1">
                    Already promoted to rental inventory ·{" "}
                    <Link
                      to={`/inventory/${unit.promotedUnitId}`}
                      className="underline hover:text-emerald-300 inline-flex items-center gap-1"
                    >
                      view <ExternalLink className="h-3 w-3" />
                    </Link>
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="gold"
                    size="sm"
                    onClick={() => renovationMutation.mutate()}
                    disabled={renovationMutation.isPending}
                  >
                    {renovationMutation.isPending ? "Saving…" : "Save renovation"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transitions panel */}
        <Card className="bg-background/40 border-border/50">
          <CardContent className="p-4 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground flex items-center gap-2">
              <History className="h-3.5 w-3.5" /> Transition history
            </h3>
            {transitions.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No transitions yet — the renovation has not been moved off its
                seeded default.
              </p>
            ) : (
              <ol className="space-y-2 text-xs">
                {transitions.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-md border border-border/50 bg-background/40 px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-foreground">
                        {t.fromStatus
                          ? `${labelOf(t.fromStatus)} → ${labelOf(t.toStatus)}`
                          : `Initialised as ${labelOf(t.toStatus)}`}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {t.changedAt.slice(0, 10)} {t.changedAt.slice(11, 16)}
                      </span>
                    </div>
                    {t.note && (
                      <p className="mt-1 text-muted-foreground whitespace-pre-wrap">
                        {t.note}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <Link
            to={`/sales/units/${unit.id}`}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Open full page <ExternalLink className="h-3 w-3" />
          </Link>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" /> Close
          </Button>
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function labelOf(status: string): string {
  if (status === "not_started" || status === "on_going" || status === "completed") {
    return STATUS_LABELS[status as RenovationStatus];
  }
  return status;
}
