import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSignature, Building2, Calendar, Wallet, KeySquare, Mail, Loader2 } from "lucide-react";
import { usePortalSession } from "@/api/portal-auth";
import {
  createPortalReservation,
  listEligibleReservationUnits,
  type CreateReservationPayload,
} from "@/api/portal-reservations";
import { TERMS_AND_CONDITIONS } from "@/lib/reservation-terms";
import { PortalApiError } from "@/lib/portal-api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput, SelectInput, TextAreaInput } from "@/components/form-ui";

type FormState = {
  propertyId: string;
  unitId: string;
  carPark: string;
  proposedMoveIn: string;
  proposedMoveOut: string;
  reservationDeposit: string;
  documentationFee: string;
  rentalDeposit: string;
  utilityDeposit: string;
  accessCardDeposit: string;
  agreedMonthlyRent: string;
  customerEmail: string;
  specialRemarks: string;
};

type SourceFilter = "all" | "own" | "other";

const EMPTY: FormState = {
  propertyId: "",
  unitId: "",
  carPark: "",
  proposedMoveIn: "",
  proposedMoveOut: "",
  reservationDeposit: "",
  documentationFee: "",
  rentalDeposit: "",
  utilityDeposit: "",
  accessCardDeposit: "",
  agreedMonthlyRent: "",
  customerEmail: "",
  specialRemarks: "",
};

// `<input type="date">` outputs "YYYY-MM-DD". The server's Zod `.datetime()`
// is strict UTC ISO with `Z`. We treat the entered date as midnight KL
// (+08:00), convert to UTC, and emit canonical `.toISOString()` form.
function dateToIsoUtc(value: string): string {
  if (!value) return "";
  return new Date(`${value}T00:00:00+08:00`).toISOString();
}

// Strict 2-decimal positive number — matches server Zod regex.
function normaliseMoney(v: string): string {
  const trimmed = v.trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) return `${trimmed}.00`;
  if (/^\d+\.\d$/.test(trimmed)) return `${trimmed}0`;
  return trimmed;
}

export default function ReservationNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [values, setValues] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // Customised T&C list. Empty array = "use bundled defaults unchanged"
  // (no approval needed). Any non-empty list = approval required, list is
  // rendered verbatim on the PDF + sign page in the order given.
  const [customTerms, setCustomTerms] = useState<string[]>([]);
  const [tncMode, setTncMode] = useState<"defaults" | "custom">("defaults");

  const tncCustomized = customTerms.length > 0;

  const unitsQuery = useQuery({
    queryKey: ["portal-eligible-units-for-reservation"],
    queryFn: listEligibleReservationUnits,
  });

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const sessionQuery = usePortalSession();
  const agentPartyId = sessionQuery.data?.partyId;

  const filteredUnits = useMemo(() => {
    const all = unitsQuery.data ?? [];
    if (sourceFilter === "all" || !agentPartyId) return all;
    // "Other Sources" includes both other agents' sourcing AND company-sourced (null sourcingAgentId).
    return all.filter((u) =>
      sourceFilter === "own"
        ? u.sourcingAgentId === agentPartyId
        : u.sourcingAgentId !== agentPartyId,
    );
  }, [unitsQuery.data, sourceFilter, agentPartyId]);

  // Derive property dropdown options from filtered units. Each unit
  // carries its property nested, so this gives the agent exactly the set of
  // properties they can pick a unit from — no orphan property selection.
  const propertiesByProperty = useMemo(() => {
    const map = new Map<string, { id: string; name: string; propertyCode: string }>();
    filteredUnits.forEach((u) => {
      if (!map.has(u.property.id)) {
        map.set(u.property.id, {
          id: u.property.id,
          name: u.property.name,
          propertyCode: u.property.propertyCode,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredUnits]);

  const unitsForSelectedProperty = useMemo(() => {
    if (!values.propertyId) return [];
    return filteredUnits
      .filter((u) => u.property.id === values.propertyId)
      .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
  }, [filteredUnits, values.propertyId]);

  function set<K extends keyof FormState>(key: K, v: FormState[K]) {
    setValues((p) => ({ ...p, [key]: v }));
    // Reset unit when property changes
    if (key === "propertyId") setValues((p) => ({ ...p, unitId: "" }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const payload: CreateReservationPayload = {
        propertyId: values.propertyId,
        unitId: values.unitId,
        carPark: values.carPark.trim() || null,
        proposedMoveIn: dateToIsoUtc(values.proposedMoveIn),
        proposedMoveOut: values.proposedMoveOut ? dateToIsoUtc(values.proposedMoveOut) : null,
        specialRemarks: values.specialRemarks.trim() || null,
        reservationDeposit: normaliseMoney(values.reservationDeposit),
        documentationFee: normaliseMoney(values.documentationFee),
        rentalDeposit: normaliseMoney(values.rentalDeposit),
        utilityDeposit: normaliseMoney(values.utilityDeposit),
        accessCardDeposit: normaliseMoney(values.accessCardDeposit),
        agreedMonthlyRent: normaliseMoney(values.agreedMonthlyRent),
        customerEmail: values.customerEmail.trim(),
        customTerms: tncMode === "custom"
          ? customTerms.map((t) => t.trim()).filter((t) => t.length > 0)
          : [],
      };
      const r = await createPortalReservation(payload);
      // List page stays mounted across the URL-param navigate below, so
      // useQuery's refetchOnMount never fires. Invalidate explicitly so the
      // newly-created reservation appears without a hard refresh.
      await qc.invalidateQueries({ queryKey: ["portal-reservations"] });
      if (r.status === "pending_approval") {
        navigate(`/portal/reservations?awaiting_approval=${r.id}`);
      } else {
        navigate(`/portal/reservations?just=${r.id}`);
      }
    } catch (err) {
      if (err instanceof PortalApiError) {
        // Server shape (formatZodError): { error: string, fieldErrors: Record<string,string> }.
        // The earlier `details.fieldErrors` nesting + `string[]` typing was a
        // leftover from the pre-T11 wire shape — it silently dropped every
        // field error, so users only saw the top-level message and never
        // the per-field hint.
        const body = err.body as
          | { error?: string; fieldErrors?: Record<string, string> }
          | null;
        setError(body?.error ?? err.message);
        setFieldErrors(body?.fieldErrors ?? {});
      } else {
        setError(err instanceof Error ? err.message : "Failed to save reservation");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const fe = (k: string): string | null => fieldErrors[k] ?? null;

  // ── Empty state: no ready-now listings available anywhere in org ──────
  if (unitsQuery.isSuccess && (unitsQuery.data ?? []).length === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6 animate-fade-in-up">
        <Header />
        <Callout variant="info" title="No ready-now listings available">
          Reservations can only be filed against active listings flagged as ready
          now. Browse the{" "}
          <a href="/portal/listings" className="underline font-semibold">
            listings
          </a>{" "}
          to see what's available, or upload a new unit at{" "}
          <a href="/portal/inventory/new" className="underline font-semibold">
            /portal/inventory/new
          </a>
          .
        </Callout>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6 animate-fade-in-up">
      <Header />

      {error && (
        <Callout variant="danger" title="Could not save reservation">
          {error}
        </Callout>
      )}

      <form onSubmit={onSubmit} className="space-y-6">
        {/* ── Property & Unit ─────────────────────────────────────── */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              Property & Unit
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2 flex gap-1 mb-1">
              {(["all", "own", "other"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    setSourceFilter(opt);
                    setValues((p) => ({ ...p, propertyId: "", unitId: "" }));
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    sourceFilter === opt
                      ? "bg-amber-500/20 text-amber-900 border border-amber-400/60 dark:text-amber-100"
                      : "bg-background/40 text-muted-foreground border border-border/40 hover:border-border/80"
                  }`}
                >
                  {opt === "all" ? "All" : opt === "own" ? "Own Agent Source" : "Other Sources"}
                </button>
              ))}
            </div>
            <Field label="Property" hint={fe("propertyId") ?? "Select from your inventory"}>

              <SelectInput
                value={values.propertyId}
                onChange={(e) => set("propertyId", e.target.value)}
                required
                disabled={unitsQuery.isLoading}
                aria-invalid={!!fe("propertyId")}
              >
                <option value="" disabled>
                  {unitsQuery.isLoading ? "Loading..." : "— Select a property —"}
                </option>
                {propertiesByProperty.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.propertyCode})
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field
              label="Unit"
              hint={
                fe("unitId") ??
                (values.propertyId
                  ? `${unitsForSelectedProperty.length} unit${
                      unitsForSelectedProperty.length === 1 ? "" : "s"
                    } available`
                  : "Pick a property first")
              }
            >
              <SelectInput
                value={values.unitId}
                onChange={(e) => set("unitId", e.target.value)}
                required
                disabled={!values.propertyId}
                aria-invalid={!!fe("unitId")}
              >
                <option value="" disabled>
                  — Select a unit —
                </option>
                {unitsForSelectedProperty.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.unitCode}
                    {u.bedrooms ? ` · ${u.bedrooms}BR` : ""}
                    {u.unitType ? ` · ${u.unitType}` : ""}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Car Park (optional)" hint={fe("carPark") ?? "e.g. P-12"}>
              <TextInput
                value={values.carPark}
                onChange={(e) => set("carPark", e.target.value)}
                placeholder="P-12"
                maxLength={40}
                aria-invalid={!!fe("carPark")}
              />
            </Field>
          </CardContent>
        </Card>

        {/* ── Dates ─────────────────────────────────────────────────── */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              Occupancy Schedule
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Proposed Move-In" hint={fe("proposedMoveIn") ?? "Required"}>
              <TextInput
                type="date"
                value={values.proposedMoveIn}
                onChange={(e) => set("proposedMoveIn", e.target.value)}
                required
                aria-invalid={!!fe("proposedMoveIn")}
              />
            </Field>
            <Field label="Proposed Move-Out (optional)" hint={fe("proposedMoveOut") ?? undefined}>
              <TextInput
                type="date"
                value={values.proposedMoveOut}
                onChange={(e) => set("proposedMoveOut", e.target.value)}
                aria-invalid={!!fe("proposedMoveOut")}
              />
            </Field>
          </CardContent>
        </Card>

        {/* ── Section 1: Reservation & Admin ────────────────────────── */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              Section 1 — Reservation & Admin Charges
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Non-refundable once the customer signs. RM, two decimals.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <CurrencyField
                label="Agreed Monthly Rent"
                value={values.agreedMonthlyRent}
                onChange={(v) => set("agreedMonthlyRent", v)}
                error={fe("agreedMonthlyRent")}
                required
              />
            </div>
            <CurrencyField
              label="Reservation Deposit"
              value={values.reservationDeposit}
              onChange={(v) => set("reservationDeposit", v)}
              error={fe("reservationDeposit")}
              required
            />
            <CurrencyField
              label="Documentation Fee"
              value={values.documentationFee}
              onChange={(v) => set("documentationFee", v)}
              error={fe("documentationFee")}
              required
            />
          </CardContent>
        </Card>

        {/* ── Section 2: Move-In Deposits ───────────────────────────── */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <KeySquare className="h-5 w-5 text-primary" />
              Section 2 — Move-In Deposits
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Payable before move-in. RM, two decimals.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <CurrencyField
              label="Rental Deposit"
              value={values.rentalDeposit}
              onChange={(v) => set("rentalDeposit", v)}
              error={fe("rentalDeposit")}
              required
            />
            <CurrencyField
              label="Utility Deposit"
              value={values.utilityDeposit}
              onChange={(v) => set("utilityDeposit", v)}
              error={fe("utilityDeposit")}
              required
            />
            <CurrencyField
              label="Access Card Deposit"
              value={values.accessCardDeposit}
              onChange={(v) => set("accessCardDeposit", v)}
              error={fe("accessCardDeposit")}
              required
            />
          </CardContent>
        </Card>

        {/* ── Customer ──────────────────────────────────────────────── */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Customer
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Recorded for your reference. <strong>No automatic email is sent</strong> — you'll
              share the sign link manually after saving.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Customer Email" hint={fe("customerEmail") ?? "Stored on the reservation; no auto-email"}>
              <TextInput
                type="email"
                value={values.customerEmail}
                onChange={(e) => set("customerEmail", e.target.value)}
                required
                placeholder="customer@example.com"
                aria-invalid={!!fe("customerEmail")}
              />
            </Field>
            <Field
              label="Special Remarks (optional)"
              hint={fe("specialRemarks") ?? "Visible to the customer on the signing page"}
            >
              <TextAreaInput
                value={values.specialRemarks}
                onChange={(e) => set("specialRemarks", e.target.value)}
                maxLength={2000}
                placeholder="Anything the customer should know — included on the printed form."
              />
            </Field>
          </CardContent>
        </Card>

        {/* ── Terms & Conditions ───────────────────────────────────── */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              Terms & Conditions
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {tncMode === "defaults"
                ? "Default 11 clauses will be printed verbatim — no manager approval needed."
                : `${customTerms.filter((t) => t.trim()).length} custom clause(s) — auto-numbered on the PDF.`}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mode switcher */}
            <div className="inline-flex rounded-lg border border-border/60 bg-background/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setTncMode("defaults");
                  setCustomTerms([]);
                }}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  tncMode === "defaults"
                    ? "bg-amber-500/20 text-amber-900 dark:text-amber-100"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Use default clauses
              </button>
              <button
                type="button"
                onClick={() => {
                  setTncMode("custom");
                  if (customTerms.length === 0) setCustomTerms([...TERMS_AND_CONDITIONS]);
                }}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  tncMode === "custom"
                    ? "bg-amber-500/20 text-amber-900 dark:text-amber-100"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Customise
              </button>
            </div>

            {tncMode === "defaults" ? (
              <div className="rounded-lg border border-border/40 bg-background/30 p-4 text-xs text-muted-foreground">
                Defaults are shown to the customer on the sign page and printed on the
                signed PDF. Switch to <strong>Customise</strong> if the agent needs to
                edit, add, or remove a clause for this reservation.
              </div>
            ) : (
              <>
                {tncCustomized && (
                  <Callout variant="warning" title="Manager approval required">
                    This reservation will go to your manager for approval before the
                    customer can sign.
                  </Callout>
                )}
                <div className="space-y-2">
                  {customTerms.map((line, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <TextAreaInput
                        rows={2}
                        value={line}
                        onChange={(e) => {
                          const next = [...customTerms];
                          next[idx] = e.target.value;
                          setCustomTerms(next);
                        }}
                        maxLength={2000}
                        placeholder="Enter a clause…"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCustomTerms(customTerms.filter((_, i) => i !== idx))}
                        aria-label={`Remove clause ${idx + 1}`}
                        className="shrink-0 text-rose-600 hover:text-rose-700"
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCustomTerms([...customTerms, ""])}
                  >
                    + Add clause
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCustomTerms([...TERMS_AND_CONDITIONS])}
                  >
                    Reset to defaults
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Clauses appear in the order shown. They are auto-numbered when the PDF is
                  generated and on the customer sign page — no need to type "1.", "2."…
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Submit ────────────────────────────────────────────────── */}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("/portal/reservations")}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" variant="gold" disabled={submitting} className="min-w-44">
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving reservation…
              </>
            ) : (
              tncCustomized ? "Submit for Approval" : "Save & Get Sign Link"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="font-display flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
        <FileSignature className="h-8 w-8 shrink-0 text-primary" />
        <span>New Reservation</span>
      </h1>
      <p className="mt-1 text-muted-foreground">
        Save a reservation for a unit in your inventory. After saving, you'll share the
        sign link with the customer manually.
      </p>
    </header>
  );
}

function CurrencyField({
  label,
  value,
  onChange,
  error,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  required?: boolean;
}) {
  return (
    <Field label={label} hint={error ?? "RM (2 decimals)"}>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
          RM
        </span>
        <TextInput
          type="text"
          inputMode="decimal"
          pattern="^\d+(\.\d{1,2})?$"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          required={required}
          placeholder="0.00"
          aria-invalid={!!error}
          className="pl-10"
        />
      </div>
    </Field>
  );
}
