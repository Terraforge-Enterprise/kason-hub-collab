// Unit Workspace — unit-first drill-in for ONE apartment's ledger (P4 §4.4).
//
// Route: /tenancy/owner-ledger/unit/:apartmentId (flag-gated ENABLE_PHASE2_OWNER_BILLING).
//
// Header: unit code · property · owner (→ owner workspace) · active tenancies,
// plus an ApartmentPicker unit switcher (§4.8: ApartmentPicker finally mounted).
// Month selector drives:
//   • the figures card — the post-#87 UnitSummaryCard, whose numbers come from
//     the SAME useUnitsSummary → computeOwnerPayout engine as the statement and
//     which already carries Print receipt / Attach bills / Per-unit statement;
//   • the entries list — GET /owner-ledger/entries with the P4-additive
//     apartmentId filter; ownerPartyId+month also trigger the route's
//     read-through sync so the month is materialised before render.
// Task 8 adds the two Add actions; Task 9 adds the documents list + Void→CN.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, BookOpen, Building2, Loader2, Minus, Plus, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { Callout } from "@/components/ui/callout";
import { PageHeader, StatusPill } from "@/components/ui";
import { TextInput } from "@/components/form-ui";
import { PaidByBadge } from "@/components/paid-by-badge";
import { ApartmentPicker } from "@/components/unit-picker";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { currentMonth } from "@/lib/date-utils";
import { labelFor } from "@/lib/string-utils";
import { useAuth } from "@/lib/auth";
import { hasMinRole } from "@/components/navigation";
import {
  useApartmentContext,
  useOwnerLedgerEntries,
  useUnitsSummary,
  useVoidLedgerEntry,
  type OwnerLedgerEntryRow,
} from "@/api/owner-ledger";
import { UnitSummaryCard } from "./unit-summary-card";
import { EntryFormDrawer } from "./entry-form-drawer";
import { ownerLedgerRowStatus, groupByDirection } from "./ledger-presentation";
import { ChargeForm } from "@/components/charge-form";
import { SelectInput, Field } from "@/components/form-ui";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBillingDocuments, useBillingDocument } from "@/api/billing-documents";
import type { BillingDocumentListItem } from "@kason/shared";
import { VoidChargeDialog } from "@/components/void-charge-dialog";
import { apiFetch, ApiError } from "@/lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

type OverlayState =
  | { kind: "void"; entry: OwnerLedgerEntryRow }
  | { kind: "add-charge" }
  | { kind: "add-entry" }
  | { kind: "void-document"; document: BillingDocumentListItem }
  // Task 5: a ledger row derived from a posted Charge (entry.sourceChargeId
  // set) — resolves via GET /billing/charges/:chargeId below and feeds the
  // SAME VoidChargeDialog mount as void-document.
  | { kind: "void-charge-entry"; chargeId: string }
  | null;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UnitWorkspacePage() {
  const { apartmentId = "" } = useParams<{ apartmentId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = hasMinRole(user?.role, "admin");
  const isEditor = hasMinRole(user?.role, "editor");
  const billingDocsOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  const queryClient = useQueryClient();
  // Add-tenant-charge tenancy pick — auto-selected when the unit has exactly one.
  const [chargeTenancyId, setChargeTenancyId] = useState<string>("");

  const [month, setMonth] = useState<string>(currentMonth);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const voidEntry = useVoidLedgerEntry();

  // Header + inverted cascade resolve (owner/property/tenancies from the unit).
  const ctxQuery = useApartmentContext(apartmentId || undefined);
  const ctx = ctxQuery.data?.data;

  // Figures — the per-owner units-summary narrowed to THIS apartment. Same
  // computeOwnerPayout output the statement uses (reuse manifest: ONE engine).
  const unitsSummaryQuery = useUnitsSummary(ctx?.ownerPartyId ?? undefined, month);
  const figures = useMemo(
    () =>
      unitsSummaryQuery.data?.data.units.find((u) => u.apartmentId === apartmentId) ?? null,
    [unitsSummaryQuery.data, apartmentId],
  );

  // Entries — owner+month trigger the read-through sync in GET /owner-ledger/entries;
  // apartmentId (P4 additive filter) narrows to this unit.
  const entriesQuery = useOwnerLedgerEntries(
    {
      ownerPartyId: ctx?.ownerPartyId ?? undefined,
      apartmentId,
      month,
      limit: 100,
    },
    { enabled: !!apartmentId && !!ctx?.ownerPartyId },
  );
  const entries = useMemo(() => entriesQuery.data?.data.rows ?? [], [entriesQuery.data]);
  // Income/Expenses/Payouts split (owner-ledger view clarity, Task 4 + Fix 1).
  // This apartmentId-scoped query structurally never returns a payout row
  // today (payouts are owner-level, no apartmentId on create) — but the
  // schema permits one, so carving Payouts out explicitly (mirroring
  // owner-workspace.tsx / month-review-sheet.tsx) rather than leaving it to
  // groupByDirection's documented drop-payout contract is defensive: a future
  // payout that DID carry this apartmentId must render, not vanish.
  const { income, expenses, payouts } = useMemo(() => {
    const { income, expenses } = groupByDirection(entries);
    const payouts = entries.filter((e) => e.direction === "payout");
    return { income, expenses, payouts };
  }, [entries]);
  // Selected charge tenancy — feeds ChargeForm's unitId/defaultPartyId props.
  // Resolving defaultPartyId HERE (instead of leaving it undefined) pins the
  // bill-to party to the tenancy chosen in THIS unit's own picker/auto-select,
  // mirroring AddFeeDrawer's defaultPartyId={tenancy?.party.partyId}
  // (tenant-tracker-drawers.tsx) — so ChargeForm never falls back to its
  // org-wide tenant picker and a mis-pick can never bill the wrong tenant.
  const selectedChargeTenancy = useMemo(
    () => ctx?.activeTenancies.find((t) => t.tenancyId === chargeTenancyId),
    [ctx, chargeTenancyId],
  );
  // While the picker jumps to a different unit, TanStack keeps rendering the
  // PREVIOUS unit's rows as placeholderData until the new fetch resolves (the
  // shared hook is intentionally left alone — other consumers rely on this for
  // pagination). Those stale rows carry Void buttons bound to the OLD unit's
  // entry ids, so gate the destructive action + surface a busy state instead.
  const entriesStale = entriesQuery.isPlaceholderData;

  // Route a ledger-row Void by its source (R1, void integrity) — shared by
  // every UnitEntriesTable section so all three (Income / Expenses / Payouts)
  // behave identically:
  //   charge-derived (sourceChargeId) → the real money+document void via the
  //     reused VoidChargeDialog (never the shallow entry void);
  //   bill-derived (sourceUtilityBillId) → send the admin to the utility
  //     bill's own void path (the backend 409s a shallow void of a sync-owned
  //     row anyway);
  //   manual/payout (no source ids) → the unchanged shallow overlay.
  const handleVoidEntry = (entry: OwnerLedgerEntryRow) => {
    if (entry.sourceChargeId) {
      setOverlay({ kind: "void-charge-entry", chargeId: entry.sourceChargeId });
    } else if (entry.sourceUtilityBillId) {
      toast.info(
        `This entry is linked to a utility bill (${labelFor(entry.category)}) — void it from the bill, not here.`,
      );
    } else {
      setOverlay({ kind: "void", entry });
    }
  };

  // Documents — BillingDocuments by the denormalized apartmentId (Plan 2).
  // Only fetched while the billing-docs flag is on (the API 404s when dark).
  //
  // Cross-contract gotcha (do NOT "fix" this back to `${month}-01`): the
  // per-owner units-summary hook above (useUnitsSummary) takes a bare
  // "YYYY-MM", while the ORG-WIDE units-summary (`useOrgUnitsSummary`, used
  // on the Units tab) wants "YYYY-MM-01". listBillingDocumentsQuery
  // (packages/shared/src/schemas/billing-documents.ts) is a THIRD contract:
  // strict `^\d{4}-\d{2}$`, no day suffix at all — matches documents-page.tsx's
  // own filter. Appending `-01` here silently 400s every request (see the
  // documentsQuery.isError branch below, which now surfaces exactly this).
  const documentsQuery = useBillingDocuments(
    billingDocsOn && apartmentId ? { apartmentId, month, pageSize: 50 } : undefined,
  );
  const documents = useMemo(
    () => documentsQuery.data?.data.items ?? [],
    [documentsQuery.data],
  );

  async function openDocumentPdf(id: string) {
    try {
      const res = await apiFetch<{ data: { url: string } }>(`/billing-documents/${id}/pdf`);
      window.open(res.data.url, "_blank", "noopener");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open the PDF.");
    }
  }

  // Void & issue Credit Note — reuses the P3.T11 VoidChargeDialog (§4.8: no
  // parallel void path). That dialog is keyed on a CHARGE ({id, chargeNumber,
  // status}), but the Documents row only carries a document; issuance groups
  // ONE document per charge, so lines[0].chargeId IS the charge (Plan 2
  // contract) — fetch the detail to resolve it. The dialog's own isPaid
  // check is charge.status in {paid, partially_paid}; BillingDocument.status
  // is DERIVED from that exact same charge state (status.service.ts
  // deriveDocumentStatus: settled <=> charge paid, partially_settled <=>
  // charge partially_paid/collected), so translating the document's status
  // into the dialog's charge-status vocabulary is a faithful 1:1 mapping,
  // not a guess.
  const voidDoc = overlay?.kind === "void-document" ? overlay.document : null;
  const voidDetailQuery = useBillingDocument(voidDoc?.id ?? null);
  // Disclosed load-flash: clicking "Void & CN" doesn't open the dialog until
  // this detail fetch resolves a chargeId (above). Without any affordance the
  // click looks like a no-op for that gap. Disable + spin ONLY the clicked
  // row's button while its own detail fetch is in flight.
  const pendingVoidDocId =
    voidDoc && voidDetailQuery.isLoading ? voidDoc.id : null;

  // Void & issue Credit Note — SECOND trigger (Task 5): a ledger row whose
  // sourceChargeId is set (auto-synced from a posted Charge). Resolves via
  // Task 4's GET /billing/charges/:chargeId, which returns the charge
  // RAW ({id,chargeNumber,status} — no `data` wrapper), so it can feed
  // voidChargeTarget directly. Same reused VoidChargeDialog mount as the
  // document-derived target above; voidChargeTarget (below) reconciles both.
  const voidChargeEntryId = overlay?.kind === "void-charge-entry" ? overlay.chargeId : null;
  const voidChargeEntryQuery = useQuery({
    queryKey: ["billing-charge", voidChargeEntryId],
    queryFn: () =>
      apiFetch<{ id: string; chargeNumber: string; status: string }>(
        `/billing/charges/${voidChargeEntryId}`,
      ),
    enabled: voidChargeEntryId !== null,
  });

  const voidChargeTarget = useMemo(() => {
    if (voidDoc) {
      const chargeId = voidDetailQuery.data?.data.lines?.[0]?.chargeId;
      if (!chargeId) return null;
      const status =
        voidDoc.status === "settled"
          ? "paid"
          : voidDoc.status === "partially_settled"
            ? "partially_paid"
            : "posted";
      return { id: chargeId, chargeNumber: voidDoc.documentNumber, status };
    }
    if (voidChargeEntryId) {
      return voidChargeEntryQuery.data ?? null;
    }
    return null;
  }, [voidDoc, voidDetailQuery.data, voidChargeEntryId, voidChargeEntryQuery.data]);
  // Fail loud instead of a silent no-op: if the detail fetch errors out, or
  // resolves with no linked charge (issuance's one-doc-per-charge invariant
  // broken), the dialog would otherwise just never appear after the admin
  // clicks "Void & CN" with no feedback at all.
  useEffect(() => {
    if (!voidDoc) return;
    if (voidDetailQuery.isError) {
      toast.error("Could not load this document — please retry.");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a query-result transition (error / no-linked-charge) with a toast + overlay-close; there is no non-effect place to observe this async settle.
      setOverlay(null);
    } else if (
      voidDetailQuery.data &&
      !voidDetailQuery.data.data.lines?.[0]?.chargeId
    ) {
      toast.error("This document has no linked charge to void.");
      setOverlay(null);
    }
  }, [voidDoc, voidDetailQuery.isError, voidDetailQuery.data]);
  // Same fail-loud contract for the ledger-row trigger (Task 5): a 404 means
  // the sync desynced (the charge this row pointed to is gone) — reuse the
  // "no linked charge" copy above. Any other fetch error gets a generic
  // retry prompt. Either way the dialog must not silently never open.
  useEffect(() => {
    if (!voidChargeEntryId) return;
    if (voidChargeEntryQuery.isError) {
      const err = voidChargeEntryQuery.error;
      if (err instanceof ApiError && err.status === 404) {
        toast.error("This entry has no linked charge to void.");
      } else {
        toast.error("Could not load the linked charge — please retry.");
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- same reset-on-async-settle pattern as the void-document effect above.
      setOverlay(null);
    }
  }, [voidChargeEntryId, voidChargeEntryQuery.isError, voidChargeEntryQuery.error]);

  // ── Not found ────────────────────────────────────────────────────────────────
  if (ctxQuery.isError) {
    return (
      <div className="space-y-6">
        <Link
          to="/tenancy/owner-ledger"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to ledger
        </Link>
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-10 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">Unit not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back crumb */}
      <div>
        <Link
          to="/tenancy/owner-ledger"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to ledger
        </Link>
      </div>

      {/* Page header — unit code + property/owner/tenancies + unit switcher */}
      <PageHeader
        title={ctx?.unitCode ?? "Unit"}
        icon={Building2}
        description={ctx ? `${ctx.propertyName} — unit-first ledger workspace.` : "Loading unit…"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Add tenant charge — writes a Charge, mints IVTEN/DEP per §4.2.
                Editor+ (matches POST /billing/charges) AND billing-docs flag
                (ChargeForm's category registry 404s while dark). */}
            {isEditor && billingDocsOn && (
              <Button
                variant="gold"
                size="sm"
                disabled={!ctx || ctx.activeTenancies.length === 0}
                title={
                  ctx && ctx.activeTenancies.length === 0
                    ? "No active tenancy — nothing to charge"
                    : undefined
                }
                onClick={() => {
                  setChargeTenancyId(
                    ctx && ctx.activeTenancies.length === 1
                      ? ctx.activeTenancies[0]!.tenancyId
                      : "",
                  );
                  setOverlay({ kind: "add-charge" });
                }}
              >
                <Plus className="h-4 w-4" /> Add tenant charge
              </Button>
            )}
            {/* Add ledger entry — OwnerLedgerEntry, never mints a document.
                Admin-only (matches POST /owner-ledger/entries). */}
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ctx?.ownerPartyId}
                title={!ctx?.ownerPartyId ? "No owner assigned to this unit" : undefined}
                onClick={() => setOverlay({ kind: "add-entry" })}
              >
                <Plus className="h-4 w-4" /> Add ledger entry
              </Button>
            )}
            <div className="w-64">
              {/* §4.8: ApartmentPicker mounted — manual unit jump. */}
              <ApartmentPicker
                value={null}
                displayName=""
                onSelect={(id) => navigate(`/tenancy/owner-ledger/unit/${id}`)}
                onClear={() => {}}
                placeholder="Jump to unit…"
              />
            </div>
          </div>
        }
      />

      {/* Owner + occupancy meta row */}
      {ctx && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-muted-foreground">
            Owner:{" "}
            {ctx.ownerPartyId ? (
              <Link
                to={`/tenancy/owner-ledger/${ctx.ownerPartyId}`}
                className="font-medium text-[var(--gold)] hover:underline"
              >
                {ctx.ownerName}
              </Link>
            ) : (
              <span className="text-muted-foreground">No owner assigned</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            {ctx.activeTenancies.length === 0
              ? "Vacant"
              : ctx.activeTenancies.map((t) => t.tenantDisplayName).join(", ")}
          </span>
        </div>
      )}

      {/* Month selector */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
          Month
        </span>
        <TextInput
          aria-label="Workspace month"
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="min-h-0 w-44 py-1.5"
        />
      </div>

      {/* Figures card — post-#87 UnitSummaryCard incl. Print receipt / Attach
          bills / Per-unit statement actions (all reused, zero re-implementation). */}
      {ctx?.ownerPartyId && figures ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <UnitSummaryCard unit={figures} ownerPartyId={ctx.ownerPartyId} month={month} />
        </div>
      ) : (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-10 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              {unitsSummaryQuery.isLoading || ctxQuery.isLoading
                ? "Loading month figures…"
                : ctx?.ownerPartyId
                  ? "No billing data for this month yet."
                  : "No owner assigned — assign an owner before booking ledger entries."}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Entries list */}
      <Card
        className={`bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden transition-opacity ${
          entriesStale ? "opacity-60" : ""
        }`}
        aria-busy={entriesStale}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-background/40">
          <span className="text-sm font-semibold text-foreground">Ledger entries</span>
          <div className="flex items-center gap-2">
            {entriesStale && (
              <span className="text-xs text-muted-foreground animate-pulse">Refreshing…</span>
            )}
            <Badge variant="secondary" className="text-xs">
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </Badge>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="overflow-x-auto">
            <table
              className="min-w-full border-collapse text-left text-sm"
              role="table"
              aria-label="Unit ledger entries"
            >
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Category</th>
                  <th className="px-4 py-3 font-semibold">Description</th>
                  <th className="px-4 py-3 font-semibold text-right">Amount</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Paid By</th>
                  <th className="px-4 py-3 font-semibold" />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                    {ctxQuery.isLoading || entriesQuery.isLoading
                      ? "Loading entries…"
                      : !ctx?.ownerPartyId
                        ? "No owner assigned — assign an owner before booking ledger entries."
                        : "No ledger entries for this unit in this month."}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-6 p-4">
            {/* Income/Expenses split (owner-ledger view clarity, Task 4) — each
                row's pill now reads settlement status (ownerLedgerRowStatus),
                not direction/raw paymentStatus. Empty groups are hidden. */}
            {income.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Income (money in)
                </h4>
                <UnitEntriesTable
                  entries={income}
                  isAdmin={isAdmin}
                  entriesStale={entriesStale}
                  onVoid={handleVoidEntry}
                />
              </section>
            )}
            {expenses.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Expenses (paid by KAEN, deducted from payout)
                </h4>
                <Callout variant="info">
                  Utilities show the full supplier bill; the tenant&apos;s share
                  appears as income above, so your net cost is the difference.
                </Callout>
                <UnitEntriesTable
                  entries={expenses}
                  isAdmin={isAdmin}
                  entriesStale={entriesStale}
                  onVoid={handleVoidEntry}
                />
              </section>
            )}
            {/* Payouts (owner-ledger view clarity, Fix 1) — hidden when empty.
                resolveStatus deliberately overrides the default
                ownerLedgerRowStatus: its non-income branch reads
                includeInPayout (false for a payout row, same as an
                owner-paid expense) and would mislabel a payout "Owner-paid".
                Void-first still takes precedence (a voided payout must read
                "Void", not its raw paymentStatus) — ownerLedgerRowStatus
                already guarantees this for Income/Expenses; inlined here
                since this resolver bypasses that helper. */}
            {payouts.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Payouts
                </h4>
                <UnitEntriesTable
                  entries={payouts}
                  isAdmin={isAdmin}
                  entriesStale={entriesStale}
                  onVoid={handleVoidEntry}
                  resolveStatus={(entry) =>
                    entry.status === "void"
                      ? { tone: "slate", label: "Void" }
                      : { tone: getStatusTone(entry.paymentStatus), label: labelFor(entry.paymentStatus) }
                  }
                />
              </section>
            )}
          </div>
        )}
      </Card>

      {/* Documents — the unit's month documents (Invoice / DN / CN / RN).
          Flag-gated: no documents mint while ENABLE_PHASE2_BILLING_DOCS is dark. */}
      {billingDocsOn && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-background/40">
            <span className="text-sm font-semibold text-foreground">Documents</span>
            <Badge variant="secondary" className="text-xs">
              {documents.length} {documents.length === 1 ? "document" : "documents"}
            </Badge>
          </div>
          <div className="overflow-x-auto">
            <table
              className="min-w-full border-collapse text-left text-sm"
              role="table"
              aria-label="Unit billing documents"
            >
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Number</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Counterparty</th>
                  <th className="px-4 py-3 font-semibold text-right">Total</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {documentsQuery.isError ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-rose-500">
                      Could not load documents for this unit — please retry.
                    </td>
                  </tr>
                ) : documents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                      {documentsQuery.isLoading
                        ? "Loading documents…"
                        : "No documents for this unit in this month."}
                    </td>
                  </tr>
                ) : (
                  documents.map((doc) => (
                    <tr
                      key={doc.id}
                      role="row"
                      aria-label={`Document ${doc.documentNumber}`}
                      className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                    >
                      <td className="px-4 py-3.5 text-sm font-medium tabular-nums">
                        {doc.documentNumber}
                        {doc.originalDocumentNumber && (
                          <div className="text-xs text-muted-foreground">
                            refs {doc.originalDocumentNumber}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <Badge variant="secondary" className="text-xs uppercase">
                          {labelFor(doc.docType)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3.5 text-sm">
                        <div>{doc.partyName}</div>
                        <div className="text-xs text-muted-foreground">{labelFor(doc.counterpartyType)}</div>
                      </td>
                      <td className="px-4 py-3.5 text-sm text-right">
                        <span className="tabular-nums font-semibold">{formatRM(Number(doc.total))}</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <StatusPill tone={getStatusTone(doc.status)}>{labelFor(doc.status)}</StatusPill>
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Open PDF ${doc.documentNumber}`}
                          onClick={() => void openDocumentPdf(doc.id)}
                        >
                          PDF
                        </Button>
                        {/* Void & CN — tenant Invoice/DN only (CN/RN are the
                            compensations themselves; IVOWN voids ride the
                            statement page per §4.3). Admin-only. */}
                        {isAdmin &&
                          doc.counterpartyType === "tenant" &&
                          (doc.docType === "invoice" || doc.docType === "debit_note") &&
                          doc.status !== "offset" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                              aria-label={`Void document ${doc.documentNumber}`}
                              disabled={pendingVoidDocId === doc.id}
                              onClick={() => setOverlay({ kind: "void-document", document: doc })}
                            >
                              {pendingVoidDocId === doc.id && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              )}
                              Void &amp; CN
                            </Button>
                          )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Void confirm — ledger entries void PLAINLY (they are not documents;
          §4.3 CN semantics apply to charges/bills/statements, not manual rows). */}
      <ConfirmAlert
        open={overlay?.kind === "void"}
        onCancel={() => setOverlay(null)}
        onConfirm={() => {
          if (overlay?.kind !== "void") return;
          const entry = overlay.entry;
          setOverlay(null);
          voidEntry.mutate(
            { id: entry.id, expectedUpdatedAt: entry.updatedAt },
            {
              onSuccess: () => toast.success("Ledger entry voided."),
              onError: (err) => {
                if (err.message.includes("409") || err.message.toLowerCase().includes("conflict")) {
                  toast.error("Entry was updated elsewhere. Please review the latest data.");
                } else {
                  toast.error(err.message);
                }
              },
            },
          );
        }}
        title="Void this ledger entry?"
        body={
          overlay?.kind === "void"
            ? `${labelFor(overlay.entry.category)} · ${formatRM(Number(overlay.entry.amount))}. Voiding cannot be undone.`
            : ""
        }
        confirmLabel="Void entry"
        destructive
      />

      {/* Add ledger entry — EntryFormDrawer with the cascade pre-resolved from
          THIS apartment (P4 initialContext). Owner-side money row; no document. */}
      {ctx?.ownerPartyId && (
        <EntryFormDrawer
          open={overlay?.kind === "add-entry"}
          onClose={() => setOverlay(null)}
          mode="create"
          owners={[{ id: ctx.ownerPartyId, displayName: ctx.ownerName ?? ctx.ownerPartyId }]}
          initialContext={{
            ownerPartyId: ctx.ownerPartyId,
            propertyId: ctx.propertyId,
            apartmentId: ctx.apartmentId,
          }}
        />
      )}

      {/* Add tenant charge — shared ChargeForm (Plan 1): category dropdown
          grouped by family + routed-document preview + its own submit. UI copy
          disambiguates from the statement sheet's owner-side "Add line". */}
      {ctx && (
        <Sheet
          open={overlay?.kind === "add-charge"}
          onOpenChange={(o) => !o && setOverlay(null)}
        >
          <SheetContent size="md">
            <SheetHeader>
              <SheetTitle>Add tenant charge · {ctx.unitCode}</SheetTitle>
              <SheetDescription>
                Bills the TENANT and issues an Invoice/Debit Note per the category
                (this is not an owner ledger line — use “Add ledger entry” for
                owner-side income/expense).
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <div className="space-y-4">
                {ctx.activeTenancies.length > 1 && (
                  <Field label="Tenancy" hint="This unit is partitioned — pick the room/tenant to bill.">
                    <SelectInput
                      aria-label="Charge tenancy"
                      value={chargeTenancyId}
                      onChange={(e) => setChargeTenancyId(e.target.value)}
                    >
                      <option value="">Select a tenant…</option>
                      {ctx.activeTenancies.map((t) => (
                        <option key={t.tenancyId} value={t.tenancyId}>
                          {t.tenantDisplayName} — {t.listingType}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                )}
                {chargeTenancyId ? (
                  <ChargeForm
                    // Keyed on the tenancy pick: ChargeForm seeds its partyId
                    // (and amount/description) via useState(defaultPartyId) at
                    // mount time only — it has no resync effect for prop
                    // changes. Without a key, switching the Tenancy select on
                    // a partitioned unit reconciles the SAME instance: the
                    // defaultPartyId prop updates but internal state doesn't,
                    // so submit() would silently POST the PREVIOUS tenant's
                    // partyId against the NEW tenancyId/unitId. A key forces a
                    // fresh mount (and correctly resets amount/description too).
                    key={chargeTenancyId}
                    tenancyId={chargeTenancyId}
                    unitId={selectedChargeTenancy?.listingId}
                    defaultPartyId={selectedChargeTenancy?.tenantPartyId}
                    layout="drawer"
                    onCreated={(charge) => {
                      toast.success(`Charge ${charge.chargeNumber} created.`);
                      // Entries, figures and (Task 9) documents all change —
                      // broad invalidation is the safe cross-plan choice.
                      void queryClient.invalidateQueries();
                      setOverlay(null);
                    }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Pick a tenancy to continue.
                  </p>
                )}
              </div>
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}

      {/* Void & issue Credit Note — REUSES the P3.T11 VoidChargeDialog
          (components/void-charge-dialog.tsx, whose own docstring already
          names "unit workspace (Plan 4)" as a mount site). Same Plan-3-modified
          POST /billing/charges/:chargeId/void endpoint; no parallel void path,
          no re-implementation of the reason-gate/three-way-fork/refund/orphan-
          proof-cleanup logic that dialog already carries + tests. */}
      <VoidChargeDialog
        charge={voidChargeTarget}
        onClose={() => setOverlay(null)}
        onDone={() => {
          // Documents, charges, entries and figures all move — broad
          // invalidation is the safe cross-plan choice (mirrors the
          // add-tenant-charge onCreated above).
          void queryClient.invalidateQueries();
        }}
      />
    </div>
  );
}

// ─── Entries sub-table (Income, Expenses, or Payouts) ──────────────────────────
// All three groups share the "Unit ledger entries" aria-label — every existing
// fixture scopes assertions to a single row (via its unique `Entry ${id}`
// aria-label) rather than to the shared table label, so
// getByRole("table", {name: /Unit ledger entries/i}) staying ambiguous across
// sections is a non-issue in practice; a test needing the table itself should
// scope with within() per section.
//
// `resolveStatus` defaults to `ownerLedgerRowStatus` (Income/Expenses'
// existing behavior, unchanged) but Payouts overrides it — see the caller's
// comment in the page component for why ownerLedgerRowStatus would mislabel
// a payout row.
/**
 * The one-line "why this number moved" note under a ledger amount.
 *
 * ⚠️ Reads server-derived strings ONLY — it never nets, subtracts or re-derives a
 * figure. The adjusted amount above it is computed server-side
 * (owner-ledger/charged-amount.ts). Renders nothing when the row's charge carries no
 * active notes, which is the overwhelming majority of rows.
 *
 * It exists because an adjustment used to be completely invisible here. On a PAID
 * charge a credit note silently lowered the collected figure while the billed figure
 * beside it stayed at the original price — reading exactly like an underpayment. On an
 * UNPAID charge it moved nothing visible at all, so raising a note looked like it had
 * simply not worked.
 */
function AdjustmentNote({ entry }: { entry: OwnerLedgerEntryRow }) {
  const debit = Number(entry.debitAdjustmentAmount ?? "0");
  const credit = Number(entry.creditAdjustmentAmount ?? "0");
  if (!(debit > 0) && !(credit > 0)) return null;
  // Wording and glyph deliberately match owner-statement-sections.ts:1044 verbatim
  // ("Debit note +RM x" / "Credit note -RM x", joined by " · "), so the same adjustment
  // reads identically on the ledger and on the statement. ASCII hyphen, not U+2212 —
  // the statement is the older surface and copy divergence between the two is exactly
  // the kind of thing nobody notices until a client asks which one is right.
  const parts: string[] = [];
  if (debit > 0) parts.push(`Debit note +${formatRM(debit)}`);
  if (credit > 0) parts.push(`Credit note -${formatRM(credit)}`);
  return (
    <div className="mt-0.5 text-[11px] font-normal text-amber-500" title="This amount is adjusted by active credit/debit notes.">
      {parts.join(" · ")}
    </div>
  );
}

function UnitEntriesTable({
  entries,
  isAdmin,
  entriesStale,
  onVoid,
  resolveStatus = ownerLedgerRowStatus,
}: {
  entries: OwnerLedgerEntryRow[];
  isAdmin: boolean;
  entriesStale: boolean;
  onVoid: (entry: OwnerLedgerEntryRow) => void;
  resolveStatus?: (entry: OwnerLedgerEntryRow) => ReturnType<typeof ownerLedgerRowStatus>;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className="min-w-full border-collapse text-left text-sm"
        role="table"
        aria-label="Unit ledger entries"
      >
        <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
          <tr>
            <th className="px-4 py-3 font-semibold">Date</th>
            <th className="px-4 py-3 font-semibold">Category</th>
            <th className="px-4 py-3 font-semibold">Description</th>
            <th className="px-4 py-3 font-semibold text-right">Amount</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 font-semibold">Paid By</th>
            <th className="px-4 py-3 font-semibold" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const st = resolveStatus(entry);
            return (
              <tr
                key={entry.id}
                role="row"
                aria-label={`Entry ${entry.id}`}
                className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
              >
                <td className="px-4 py-3.5 text-sm whitespace-nowrap tabular-nums">
                  {formatDate(entry.transactionDate)}
                </td>
                <td className="px-4 py-3.5 text-sm text-muted-foreground">
                  {labelFor(entry.category)}
                </td>
                <td className="px-4 py-3.5 text-sm text-muted-foreground max-w-xs truncate">
                  {entry.description ?? "—"}
                </td>
                <td className="px-4 py-3.5 text-sm text-right">
                  <span
                    className={`font-semibold tabular-nums ${
                      entry.direction === "expense"
                        ? "text-rose-400"
                        : entry.direction === "payout"
                          ? "text-sky-500"
                          : "text-emerald-500"
                    }`}
                  >
                    {entry.direction === "expense" && (
                      <Minus className="h-3 w-3 inline mr-0.5" />
                    )}
                    {/* Show the BILLED price. Income `amount` is collected-so-far
                        (0 until the tenant pays); chargedAmount carries the price.
                        Fallback to `amount` is the norm for expenses (already
                        billed) — invariant: null here means "no billed figure",
                        not a dropped field. Server-side CN/DN-adjusted. */}
                    {formatRM(Number(entry.chargedAmount ?? entry.amount))}
                  </span>
                  {/* Why this figure is not the one on the original document. Without
                      it a credit note silently changed the number — or, on an unpaid
                      charge, silently changed NOTHING visible — and the reader had no
                      way to tell an adjustment from an underpayment. */}
                  <AdjustmentNote entry={entry} />
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill tone={st.tone}>{st.label}</StatusPill>
                </td>
                <td className="px-4 py-3.5">
                  <PaidByBadge paidBy={entry.paidBy} />
                </td>
                <td className="px-4 py-3.5 text-right whitespace-nowrap">
                  {isAdmin && entry.status !== "void" && !entriesStale && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                      aria-label={`Void entry ${entry.id}`}
                      onClick={() => onVoid(entry)}
                    >
                      Void
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
