import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Info } from "lucide-react";
import { Building2, Calculator, Calendar, User, Users } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PhoneInput } from "@/components/phone-input";
import { portalApiFetch } from "@/lib/portal-api";
// useRoomTypes removed: Room Type options now come from the selected unit's rooms
import { useTaTierLookup } from "@/hooks/use-ta-tier-lookup";
import { useTaTierOptions } from "@/hooks/use-ta-tier-options";
import { useExistingClaimsOnKey } from "@/hooks/use-existing-claims-on-key";
import type {
  ClaimItemRow,
  PropertyResult,
  ClaimType,
  PropertyUnit,
} from "./use-claim-form";

// ── Constants ────────────────────────────────────────────────────────────────

// Hard-coded list of valid KAEN tenancy-agreement charges (RM). Matches the
// "Charges by KAEN" dropdown options come from the live TaTier table for the
// caller's org (see useTaTierOptions). Previously hardcoded as
// [216, 324, 432, 540, 648, 756, 864, 972, 1080] — that was wrong because
// admin-configured tiers in /commissions/settings would not flow through.

// ── Helpers ──────────────────────────────────────────────────────────────────

// Intentionally local — portal uses "RM x" prefix format, not the shared
// formatMoney() which returns "x MYR" suffix format.
function formatMYR(amount: number) {
  return `RM ${amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ── Payout Breakdown Components ──────────────────────────────────────────────

type BreakdownProps = {
  monthlyRental: string | number;
  numberOfPax?: number | string;
  paxDeductionAmount?: string | number | null;
  hasPaxDeduction: boolean;
  tierPercentage: string | number;
  commissionPercentage: string | number;
  tenancyChargesByAgent: string | number;
  tenancyChargesByKaen: string | number;
  isCobroke?: boolean;
  taSharePercent?: string | number;
  shortfallApplied?: number;
  outstandingBalance?: number;
};

function PayoutBreakdown(props: BreakdownProps) {
  const monthly    = Number(props.monthlyRental || 0);
  const paxCount   = Number(props.numberOfPax ?? 0);
  const paxAmount  = Number(props.paxDeductionAmount ?? 0);
  const paxApplied = Boolean(props.hasPaxDeduction) && paxCount > 0;
  const paxDeduction = paxApplied ? paxCount * paxAmount : 0;
  const adjusted   = monthly - paxDeduction;
  const tier       = Number(props.tierPercentage || 0);
  const comm       = Number(props.commissionPercentage || 0);
  const commission = adjusted * (tier / 100) * (comm / 100);
  const chargedToTenant = Number(props.tenancyChargesByAgent || 0);
  const kaen            = Number(props.tenancyChargesByKaen || 0);
  const tenancyDiff     = chargedToTenant - kaen;
  // Mirror server math (compute-nett-payout.ts:74-83): TA profit splits by
  // taSharePercent; shortfall splits by commission ratio (already baked into
  // shortfallApplied passed from server). Without the split here, preview
  // overstates nett by (100-taSharePercent)% × profit — silent surprise on submit.
  const taShare = props.isCobroke ? Number(props.taSharePercent || 0) : 100;
  const taProfit       = Math.max(0, tenancyDiff);
  const agentTaIncome  = taProfit * (taShare / 100);
  const taLane         = tenancyDiff < 0 ? tenancyDiff : agentTaIncome;
  const shortfallApplied = props.shortfallApplied ?? 0;
  const outstandingBalance = props.outstandingBalance ?? 0;
  const nett            = commission + taLane - shortfallApplied;
  const fmt = (n: number) =>
    `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-3 tabular-nums">
      {/* Section 1 — Rental Base */}
      <section className="border rounded-lg p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Rental Base</div>
        <BreakRow label="Monthly Rental" value={fmt(monthly)} />
        {paxApplied && (
          <>
            <BreakRow
              label={`Pax Deduction (${paxCount} × ${fmt(paxAmount)})`}
              value={`– ${fmt(paxDeduction)}`}
              negative
            />
            <Divider />
            <BreakRow label="Adjusted Rental" value={fmt(adjusted)} strong />
          </>
        )}
      </section>

      {/* Section 2 — Commission */}
      <section className="border rounded-lg p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Commission</div>
        <BreakRow
          label={paxApplied ? "Adjusted Rental" : "Monthly Rental"}
          value={fmt(paxApplied ? adjusted : monthly)}
        />
        <BreakRow label="× Agent Tier" value={`${tier}%`} />
        <BreakRow label="× Commission Rate" value={`${comm}%`} />
        <Divider />
        <BreakRow label="Commission" value={fmt(commission)} strong />
      </section>

      {/* Section 3 — Tenancy Agreement */}
      <section className="border rounded-lg p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Tenancy Agreement</div>
        <BreakRow label="Charged to Tenant" value={fmt(chargedToTenant)} />
        <BreakRow label="Kaen Fee" value={`– ${fmt(kaen)}`} negative />
        <Divider />
        <BreakRow label="Tenancy Diff" value={fmt(tenancyDiff)} strong />
        {props.isCobroke && tenancyDiff > 0 && (
          <>
            <BreakRow label="× Your TA Share" value={`${taShare}%`} />
            <Divider />
            <BreakRow label="Your TA Income" value={fmt(agentTaIncome)} strong />
          </>
        )}
      </section>

      {/* Shortfall deducted */}
      {shortfallApplied > 0 && (
        <BreakRow
          label="Shortfall deducted"
          value={`− ${fmt(shortfallApplied)}`}
          negative
        />
      )}

      {/* Outstanding balance */}
      {outstandingBalance > 0 && (
        <div className="border rounded-lg p-3 border-red-500/30 bg-red-500/5">
          <BreakRow
            label="Outstanding balance"
            value={fmt(outstandingBalance)}
            negative
          />
          <p className="text-xs text-red-500 mt-1">
            This amount will be owed to KAEN — clear it before this claim can be approved.
          </p>
        </div>
      )}

      {/* Total */}
      <div className="flex justify-between items-center border-t-2 border-double pt-3">
        <div className="text-sm">Nett Payout</div>
        <div className="text-amber-500 font-bold text-xl">{fmt(nett)}</div>
      </div>
    </div>
  );
}

function BreakRow({ label, value, negative, strong }: { label: string; value: string; negative?: boolean; strong?: boolean }) {
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className={strong ? "font-semibold" : ""}>{label}</span>
      <span className={`${strong ? "font-semibold" : ""} ${negative ? "text-red-600" : ""}`}>{value}</span>
    </div>
  );
}

function HintIcon({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label="Show hint"
          className="inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
        >
          <Info className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Divider() {
  return <div className="border-t my-1" />;
}

// ── Remark Field ─────────────────────────────────────────────────────────────

function RemarkField(props: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(props.value.length > 0);
  if (!open) {
    return (
      <button
        type="button"
        className="text-sm underline text-primary mt-2"
        onClick={() => setOpen(true)}
      >
        + Add remark
      </button>
    );
  }
  return (
    <div className="border rounded p-3 mt-2">
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm">
          Remark <span className="text-muted-foreground">(optional)</span>
        </label>
        <button
          type="button"
          aria-label="Collapse remark"
          className="text-sm"
          onClick={() => setOpen(false)}
        >
          –
        </button>
      </div>
      <textarea
        rows={4}
        maxLength={1000}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full px-2 py-1 rounded border bg-background"
      />
      <div className="text-xs text-muted-foreground text-right mt-1">
        {props.value.length} / 1000
      </div>
    </div>
  );
}

// ── Property Selector ────────────────────────────────────────────────────────

function PropertySelector({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (property: PropertyResult) => void;
}) {
  const [search, setSearch] = useState(value);
  const [open, setOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSearch(value); }, [value]);

  const { data } = useQuery({
    queryKey: ["agent-properties", debouncedSearch],
    queryFn: () =>
      portalApiFetch<{ data: PropertyResult[] }>(
        `/commissions/properties${debouncedSearch ? `?q=${encodeURIComponent(debouncedSearch)}` : ""}`,
      ),
    enabled: open,
    staleTime: 30_000,
  });

  const properties = data?.data ?? [];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        required
        value={search}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        placeholder="Search property..."
        className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
      />
      {open && properties.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-[var(--input-border)] bg-popover shadow-lg">
          {properties.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onSelect(p);
                setSearch(p.name);
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-left text-sm text-popover-foreground hover:bg-accent flex items-center justify-between"
            >
              <span>{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.units.length} units</span>
            </button>
          ))}
        </div>
      )}
      {open && search && properties.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-[var(--input-border)] bg-popover shadow-lg px-3 py-2 text-sm text-muted-foreground">
          No properties found
        </div>
      )}
    </div>
  );
}

// ── IC Upload Field ──────────────────────────────────────────────────────────

function IcUploadField({
  label, side, storageKey, onChange,
}: {
  label: string;
  side: "front" | "back";
  storageKey: string;
  onChange: (key: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "uploading" | "uploaded" | "failed">(
    storageKey ? "uploaded" : "idle",
  );
  const [progress, setProgress] = useState(0);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  // Re-fetch thumbnail when an existing key is hydrated from a saved draft.
  useEffect(() => {
    if (storageKey && !thumbUrl) {
      portalApiFetch<{ data: { viewUrl: string } }>(`/tenant-ic/view-url?storageKey=${encodeURIComponent(storageKey)}`)
        .then((r) => setThumbUrl(r.data.viewUrl))
        .catch(() => { /* ignore — preview is best-effort */ });
    }
  }, [storageKey, thumbUrl]);

  const upload = async (file: File) => {
    if (!["image/jpeg", "image/png", "image/heic"].includes(file.type)) {
      setErrorMsg("Unsupported format. Please use JPEG, PNG, or HEIC.");
      setStatus("failed");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg("File too large. Maximum 10 MB allowed.");
      setStatus("failed");
      return;
    }
    setErrorMsg(null);
    setStatus("uploading");
    setProgress(0);
    setThumbUrl(URL.createObjectURL(file));   // instant local preview

    try {
      const res = await portalApiFetch<{
        data: {
          uploadUrl: string;
          method: string;
          headers: Record<string, string>;
          storageKey: string;
        };
      }>(
        `/tenant-ic/upload-url`,
        { method: "POST", body: JSON.stringify({ side, contentType: file.type }) },
      );
      const signed = res.data;
      // Direct upload to Supabase with progress. Method + headers must come
      // from the server — Supabase signed-upload URLs are POST-only and
      // require an authorization Bearer token (PUT returns 404).
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.open(signed.method, signed.uploadUrl);
        for (const [k, v] of Object.entries(signed.headers)) xhr.setRequestHeader(k, v);
        xhr.send(file);
      });
      onChange(signed.storageKey);
      setStatus("uploaded");
    } catch (err) {
      setStatus("failed");
      setErrorMsg(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const remove = async () => {
    if (!storageKey) return;
    try {
      await portalApiFetch(`/tenant-ic/upload`, {
        method: "DELETE",
        body: JSON.stringify({ storageKey }),
      });
    } catch { /* ignore — sweeper will clean up */ }
    onChange("");
    setStatus("idle");
    setProgress(0);
    setThumbUrl(null);
  };

  return (
    <div className="rounded-lg border border-border/40 bg-background/30 p-3">
      <label className="block text-sm font-medium text-foreground mb-2">{label}</label>
      {status === "idle" && (
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            className="flex-1 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground hover:bg-muted/30 transition"
            onClick={() => fileRef.current?.click()}
          >
            Drop image or [Choose file] · JPEG, PNG, HEIC · max 10 MB
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/30 transition"
            onClick={() => cameraRef.current?.click()}
          >
            Use Camera
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/heic" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
      )}
      {(status === "uploading" || status === "uploaded" || status === "failed") && (
        <div className="flex items-start gap-3">
          {thumbUrl && <img src={thumbUrl} alt="" className="w-24 h-16 rounded object-cover" />}
          <div className="flex-1 text-sm">
            {status === "uploading" && (
              <>
                <progress className="w-full h-2" max={100} value={progress} aria-label="Upload progress" />
                <p role="status" aria-live="polite" className="text-muted-foreground mt-1">Uploading {progress}%&hellip;</p>
              </>
            )}
            {status === "uploaded" && (
              <>
                <p role="status" aria-live="polite" className="text-emerald-600">&#10003; Uploaded</p>
                <div className="flex gap-3 mt-1">
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => thumbUrl && window.open(thumbUrl, "_blank")}>Preview</button>
                  <button type="button" className="text-xs text-rose-600 hover:underline" onClick={remove}>Remove</button>
                </div>
              </>
            )}
            {status === "failed" && (
              <>
                <p role="alert" aria-live="assertive" className="text-rose-600">{errorMsg ?? "Upload failed"}</p>
                <button type="button" className="text-xs text-primary hover:underline mt-1" onClick={() => fileRef.current?.click()}>Retry</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Props ────────────────────────────────────────────────────────────────────

export type ClaimItemsTableProps = {
  items: ClaimItemRow[];
  claimType: ClaimType;
  selectedProperties: Map<string, PropertyResult>;
  tierPercentage: number;
  hasError: (itemIndex: number, field: string) => boolean;
  getError: (itemIndex: number, field: string) => string | undefined;
  onAddItem: () => void;
  onRemoveItem: (index: number) => void;
  onUpdateItem: (index: number, field: keyof ClaimItemRow, value: string | boolean | number) => void;
  onPropertySelect: (index: number, property: PropertyResult) => void;
  onClearError: (itemIndex: number, field: string) => void;
  onBannerData?: (index: number, data: { count: number; remainingPct: string } | null) => void;
};

// ── Per-item card (extracted so useTaTierLookup can be called as a hook) ─────

type ClaimItemCardProps = {
  item: ClaimItemRow;
  index: number;
  totalItems: number;
  claimType: ClaimType;
  property: PropertyResult | undefined;
  tierPercentage: number;
  hasError: (itemIndex: number, field: string) => boolean;
  getError: (itemIndex: number, field: string) => string | undefined;
  onRemoveItem: (index: number) => void;
  onUpdateItem: (index: number, field: keyof ClaimItemRow, value: string | boolean | number) => void;
  onPropertySelect: (index: number, property: PropertyResult) => void;
  onClearError: (itemIndex: number, field: string) => void;
  onBannerData?: (index: number, data: { count: number; remainingPct: string } | null) => void;
};

function ClaimItemCard({
  item,
  index,
  totalItems,
  claimType,
  property,
  tierPercentage,
  hasError,
  getError,
  onRemoveItem,
  onUpdateItem,
  onPropertySelect,
  onClearError,
  onBannerData,
}: ClaimItemCardProps) {
  const inputClass =
    "w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]";
  const errorInputClass =
    "w-full rounded-md border border-red-500 bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-red-500 focus:ring-2 focus:ring-red-500/20";
  const inputClassFor = (field: string) =>
    hasError(index, field) ? errorInputClass : inputClass;

  const units = property?.units ?? [];
  // Derive rooms for the currently selected unit so the Room Type dropdown
  // is scoped to this unit only (Task 5b — Noelle WA 22 May 10:16am).
  const selectedUnit: PropertyUnit | undefined = units.find(
    (u) => u.unitCode === item.unitCode,
  );

  // ── TA Tier auto-fill ────────────────────────────────────────────────────
  // Always sync the KAEN dropdown to the matching tier when rental changes.
  // Agent can still pick a different value from the dropdown manually; the
  // next rental change will resync. No "manual override" state — keep it simple.
  const { data: taTier } = useTaTierLookup(item.monthlyRental);
  const { data: taTierOptionsData } = useTaTierOptions();
  const kaenChargeOptions = taTierOptionsData?.tiers ?? [];

  // Listing-portion claims are passive income — no TA charges flow through
  // the listing agent, so skip the tier auto-fill and let the field stay 0.
  const isListingPortion = claimType === "listing_portion";

  useEffect(() => {
    if (isListingPortion) return;
    if (taTier?.companyMinimum) {
      const tierValue = String(taTier.companyMinimum);
      if (String(item.tenancyChargesByKaen || "") !== tierValue) {
        onUpdateItem(index, "tenancyChargesByKaen", taTier.companyMinimum);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taTier?.companyMinimum, isListingPortion]);

  // ── Existing claims banner ───────────────────────────────────────────────
  const existingClaimsQuery = useExistingClaimsOnKey({
    propertyId: item.propertyId || null,
    unitCode: item.unitCode,
    roomType: item.roomType,
    moveInDate: item.moveInDate,
  });
  const existingCount = existingClaimsQuery.data?.count ?? 0;
  const existingRemainingPct = existingClaimsQuery.data?.remainingPct ?? "100";

  // Lift banner data to parent for submit-time cobroke check
  useEffect(() => {
    if (!onBannerData) return;
    if (existingClaimsQuery.data) {
      onBannerData(index, {
        count: existingClaimsQuery.data.count,
        remainingPct: existingClaimsQuery.data.remainingPct,
      });
    } else {
      onBannerData(index, null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingClaimsQuery.data, index]);

  // ── Shortfall calculation ────────────────────────────────────────────────
  const kaen = Number(item.tenancyChargesByKaen || 0);
  const chargedToTenant = Number(item.tenancyChargesByAgent || 0);
  const shortfall = Math.max(0, kaen - chargedToTenant);

  const paxApplied = item.hasPaxDeduction && Number(item.numberOfPax) > 0;
  const paxDeduction = paxApplied ? Number(item.numberOfPax) * (item.paxDeductionAmount || 0) : 0;
  const adjustedRental = Number(item.monthlyRental || 0) - paxDeduction;
  const commission = adjustedRental * (tierPercentage / 100) * (Number(item.commissionPercentage || 0) / 100);
  const shortfallApplied = Math.min(shortfall, commission);
  const outstandingBalance = shortfall - shortfallApplied;

  const showBreakdown = !!(item.monthlyRental && item.commissionPercentage && item.tenancyChargesByKaen);

  const shareNum = Number(item.commissionPercentage || 0);

  return (
    <>
      {/* ── Per-item existing-claims banner ──────────────────────────────── */}
      {existingCount > 0 && (
        <Callout variant="warning" title={`${existingCount} other agent(s) claimed on this deal`}>
          {existingCount} other agent(s) have claimed{" "}
          {String(100 - Number(existingRemainingPct))}% on this deal. Max share available for you:{" "}
          <span className="font-semibold">{existingRemainingPct}%</span>.
        </Callout>
      )}

    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold">Item {index + 1}</CardTitle>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onRemoveItem(index)}
            disabled={totalItems <= 1}
            className="text-red-400 hover:text-red-300"
          >
            Remove
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── Section: Property ─────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Property
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Condo */}
            <div id={`field-${index}-condoName`}>
              <label className="block text-sm text-muted-foreground mb-1">Condo *</label>
              <div className={hasError(index, "condoName") ? "[&_input]:border-red-500 [&_input]:focus:border-red-500 [&_input]:focus:ring-red-500/20" : ""}>
                <PropertySelector
                  value={item.condoName}
                  onSelect={(p) => { onPropertySelect(index, p); onClearError(index, "condoName"); }}
                />
              </div>
              {hasError(index, "condoName") && <p className="mt-1 text-xs text-red-500">{getError(index, "condoName")}</p>}
            </div>

            {/* Unit */}
            <div id={`field-${index}-unitCode`}>
              <label className="block text-sm text-muted-foreground mb-1">Unit *</label>
              {units.length > 0 ? (
                <select
                  required
                  value={item.unitCode}
                  onChange={(e) => {
                    onUpdateItem(index, "unitCode", e.target.value);
                    // Cascade: clear Room Type whenever the unit changes so the
                    // user must re-pick from the new unit's rooms.
                    onUpdateItem(index, "roomType", "");
                    onClearError(index, "unitCode");
                  }}
                  className={inputClassFor("unitCode")}
                >
                  <option value="">Select unit</option>
                  {units.map((u) => (
                    <option key={u.unitCode} value={u.unitCode}>
                      {u.unitCode}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  required
                  value={item.unitCode}
                  onChange={(e) => { onUpdateItem(index, "unitCode", e.target.value); onClearError(index, "unitCode"); }}
                  placeholder="e.g. A-12-01"
                  className={inputClassFor("unitCode")}
                />
              )}
              {hasError(index, "unitCode") && <p className="mt-1 text-xs text-red-500">{getError(index, "unitCode")}</p>}
            </div>

            {/* Room Type — scoped to the selected unit's rooms */}
            <div id={`field-${index}-roomType`}>
              <label className="block text-sm text-muted-foreground mb-1">Room Type *</label>
              <select
                required
                disabled={!item.unitCode}
                value={item.roomType}
                onChange={(e) => { onUpdateItem(index, "roomType", e.target.value); onClearError(index, "roomType"); }}
                className={inputClassFor("roomType")}
              >
                <option value="">Select room type</option>
                {(selectedUnit?.rooms ?? []).map((r) => (
                  <option key={r.id} value={r.roomType}>{r.roomType}</option>
                ))}
              </select>
              {hasError(index, "roomType") && <p className="mt-1 text-xs text-red-500">{getError(index, "roomType")}</p>}
            </div>
          </div>
        </div>

        {/* ── Section: Tenant & Dates ──────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <User className="h-4 w-4 text-muted-foreground" />
            Tenant Details
          </h3>
          {/* 5-col grid on desktop: Tenant Name spans 2 cells (so long names like
              "Muhammad Hafiz bin Abdul Rahman" stay readable), each date takes 1.
              sm: 2-col stacked rows; mobile: full stack. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Tenant Name — spans 2 cells on desktop for long full names */}
            <div id={`field-${index}-tenantName`} className="lg:col-span-2">
              <label className="block text-sm text-muted-foreground mb-1">Tenant Name *</label>
              <input
                type="text"
                required
                value={item.tenantName}
                onChange={(e) => { onUpdateItem(index, "tenantName", e.target.value); onClearError(index, "tenantName"); }}
                placeholder="e.g. Ahmad bin Abdullah"
                className={inputClassFor("tenantName")}
              />
              {hasError(index, "tenantName") && <p className="mt-1 text-xs text-red-500">{getError(index, "tenantName")}</p>}
            </div>

            {/* Sales Date */}
            <div id={`field-${index}-salesDate`}>
              <label className="block text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                <Calendar className="h-3 w-3 text-muted-foreground/70" />
                Sales date *
              </label>
              <input
                type="date"
                required
                value={item.salesDate}
                onChange={(e) => { onUpdateItem(index, "salesDate", e.target.value); onClearError(index, "salesDate"); }}
                className={inputClassFor("salesDate")}
              />
              {hasError(index, "salesDate") && <p className="mt-1 text-xs text-red-500">{getError(index, "salesDate")}</p>}
            </div>

            {/* Move-in Date */}
            <div id={`field-${index}-moveInDate`}>
              <label className="block text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                <Calendar className="h-3 w-3 text-muted-foreground/70" />
                Move-in *
              </label>
              <input
                type="date"
                required
                value={item.moveInDate}
                onChange={(e) => { onUpdateItem(index, "moveInDate", e.target.value); onClearError(index, "moveInDate"); }}
                className={inputClassFor("moveInDate")}
              />
              {hasError(index, "moveInDate") && <p className="mt-1 text-xs text-red-500">{getError(index, "moveInDate")}</p>}
            </div>

            {/* Move-out Date */}
            <div id={`field-${index}-moveOutDate`}>
              <label className="block text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                <Calendar className="h-3 w-3 text-muted-foreground/70" />
                Move-out *
              </label>
              <input
                type="date"
                required
                value={item.moveOutDate}
                onChange={(e) => { onUpdateItem(index, "moveOutDate", e.target.value); onClearError(index, "moveOutDate"); }}
                className={inputClassFor("moveOutDate")}
              />
              {hasError(index, "moveOutDate") && <p className="mt-1 text-xs text-red-500">{getError(index, "moveOutDate")}</p>}
            </div>
          </div>
        </div>

        {/* ── Section: Tenant Profile (optional, B1) ────────────── */}
        <details className="rounded-lg border border-border/40 bg-background/30 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-foreground select-none">
            Tenant Profile (optional)
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Helps the manager review the claim and pitch follow-up services.
            </span>
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <div id={`field-${index}-tenantEmail`}>
              <label htmlFor={`input-${index}-tenantEmail`} className="block text-sm text-muted-foreground mb-1">Tenant Email</label>
              <input
                id={`input-${index}-tenantEmail`}
                type="email"
                value={item.tenantEmail}
                onChange={(e) => onUpdateItem(index, "tenantEmail", e.target.value)}
                placeholder="ahmad@example.com"
                className={inputClass}
              />
            </div>
            <div id={`field-${index}-tenantPhone`}>
              {/* <PhoneInput> emits the canonical "60xxxxxxxxx" form (or null);
                  ClaimItemRow.tenantPhone is typed string so we coerce null to
                  "" — the buildPayload converts "" → undefined for the wire. */}
              <PhoneInput
                label="Tenant Phone"
                value={item.tenantPhone || null}
                onChange={(canonical) => onUpdateItem(index, "tenantPhone", canonical ?? "")}
              />
            </div>
            <div id={`field-${index}-tenantLinkedinUrl`}>
              <label htmlFor={`input-${index}-tenantLinkedinUrl`} className="block text-sm text-muted-foreground mb-1">LinkedIn URL</label>
              <input
                id={`input-${index}-tenantLinkedinUrl`}
                type="url"
                value={item.tenantLinkedinUrl}
                onChange={(e) => onUpdateItem(index, "tenantLinkedinUrl", e.target.value)}
                placeholder="https://www.linkedin.com/in/..."
                className={inputClass}
              />
              {item.tenantLinkedinUrl && !/linkedin\.com/i.test(item.tenantLinkedinUrl) && (
                <p className="text-xs text-red-500 mt-1">Must be a LinkedIn URL.</p>
              )}
            </div>
            <div id={`field-${index}-tenantInstagramHandle`}>
              <label htmlFor={`input-${index}-tenantInstagramHandle`} className="block text-sm text-muted-foreground mb-1">Instagram (without @)</label>
              <input
                id={`input-${index}-tenantInstagramHandle`}
                type="text"
                value={item.tenantInstagramHandle}
                onChange={(e) => onUpdateItem(index, "tenantInstagramHandle", e.target.value.replace(/^@/, ""))}
                placeholder="ahmad_a"
                className={inputClass}
                maxLength={30}
              />
            </div>
            <div id={`field-${index}-tenantJobPosition`} className="sm:col-span-2">
              <label htmlFor={`input-${index}-tenantJobPosition`} className="block text-sm text-muted-foreground mb-1">Tenant Job Position</label>
              <input
                id={`input-${index}-tenantJobPosition`}
                type="text"
                value={item.tenantJobPosition}
                onChange={(e) => onUpdateItem(index, "tenantJobPosition", e.target.value)}
                placeholder="e.g. Software Engineer"
                className={inputClass}
                maxLength={200}
              />
            </div>
            <div className="sm:col-span-2 mt-4 pt-4 border-t border-border/40">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">IC Images *</p>
              <div className="space-y-4">
                <div id={`field-${index}-tenantIcFrontKey`}>
                  <IcUploadField
                    label="IC Front *"
                    side="front"
                    storageKey={item.tenantIcFrontKey}
                    onChange={(key) => { onUpdateItem(index, "tenantIcFrontKey", key); onClearError(index, "tenantIcFrontKey"); }}
                  />
                  {hasError(index, "tenantIcFrontKey") && <p className="mt-1 text-xs text-red-500">{getError(index, "tenantIcFrontKey")}</p>}
                </div>
                <div id={`field-${index}-tenantIcBackKey`}>
                  <IcUploadField
                    label="IC Back *"
                    side="back"
                    storageKey={item.tenantIcBackKey}
                    onChange={(key) => { onUpdateItem(index, "tenantIcBackKey", key); onClearError(index, "tenantIcBackKey"); }}
                  />
                  {hasError(index, "tenantIcBackKey") && <p className="mt-1 text-xs text-red-500">{getError(index, "tenantIcBackKey")}</p>}
                </div>
              </div>
            </div>
          </div>
        </details>

        {/* ── Section: Financial ────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Calculator className="h-4 w-4 text-muted-foreground" />
            Commission Calculation
          </h3>
          <div className="space-y-4">
            {/* All 4 inputs on one row at lg, 2x2 at sm, stacked at mobile.
                Long hints moved into <HintIcon> tooltips next to each label
                so the field row stays scannable. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div id={`field-${index}-monthlyRental`}>
                <label className="text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                  Monthly Rental (RM) *
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  step="0.01"
                  value={item.monthlyRental}
                  onChange={(e) => { onUpdateItem(index, "monthlyRental", e.target.value); onClearError(index, "monthlyRental"); }}
                  placeholder="0.00"
                  className={inputClassFor("monthlyRental")}
                />
                {hasError(index, "monthlyRental") && <p className="mt-1 text-xs text-red-500">{getError(index, "monthlyRental")}</p>}
              </div>

              {/* Commission % — ALWAYS visible. Hint copy moved into a tooltip. */}
              <div id={`field-${index}-commissionPercentage`}>
                <label className="text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                  Commission % *
                  <HintIcon>
                    Your share of the rental commission for this deal. Enter <span className="font-medium">100</span> if you handled it solo. Enter your negotiated share (e.g. 50, 70) if you closed it jointly with another agent — they file their own claim for the remaining %.
                    {item.hasCobrokeIntent && (
                      <span className="block mt-1">Cobroke is a separate TA-only split below — it does not change this %.</span>
                    )}
                  </HintIcon>
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  max={Number(existingRemainingPct) || 100}
                  step="0.01"
                  value={item.commissionPercentage}
                  onChange={(e) => { onUpdateItem(index, "commissionPercentage", e.target.value); onClearError(index, "commissionPercentage"); }}
                  placeholder="100"
                  className={inputClassFor("commissionPercentage")}
                />
                {existingCount > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">Max available: {existingRemainingPct}%</p>
                )}
                {hasError(index, "commissionPercentage") && <p className="mt-1 text-xs text-red-500">{getError(index, "commissionPercentage")}</p>}
                {shareNum > 0 && shareNum < 100 && existingCount === 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    Joint deal: partner(s) file for the remaining {(100 - shareNum).toFixed(2).replace(/\.00$/, "")}%.
                  </p>
                )}
              </div>

              <div id={`field-${index}-tenancyChargesByAgent`}>
                <label className="text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                  Charged to Tenant (RM){isListingPortion ? "" : " *"}
                  <HintIcon>
                    {isListingPortion
                      ? "Listing portion is passive income — leave at 0; tenant-side claim handles TA charges."
                      : "Amount the tenant pays to the agent for the tenancy agreement."}
                  </HintIcon>
                </label>
                <input
                  type="number"
                  required={!isListingPortion}
                  min={0}
                  step="0.01"
                  value={item.tenancyChargesByAgent}
                  onChange={(e) => { onUpdateItem(index, "tenancyChargesByAgent", e.target.value); onClearError(index, "tenancyChargesByAgent"); }}
                  placeholder="0.00"
                  className={inputClassFor("tenancyChargesByAgent")}
                />
                {hasError(index, "tenancyChargesByAgent") && <p className="mt-1 text-xs text-red-500">{getError(index, "tenancyChargesByAgent")}</p>}
              </div>

              <div id={`field-${index}-tenancyChargesByKaen`}>
                <label className="text-sm text-muted-foreground mb-1 flex items-center gap-1.5">
                  Charges by KAEN{isListingPortion ? "" : " *"}
                  <HintIcon>
                    {isListingPortion
                      ? "Listing portion is passive income — leave at 0; tenant-side claim pays the KAEN fee."
                      : "KAEN's required minimum from the tenancy agreement, auto-derived from monthly rental tier."}
                  </HintIcon>
                </label>
                {isListingPortion ? (
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={item.tenancyChargesByKaen}
                    onChange={(e) => { onUpdateItem(index, "tenancyChargesByKaen", e.target.value); onClearError(index, "tenancyChargesByKaen"); }}
                    placeholder="0.00"
                    className={inputClassFor("tenancyChargesByKaen")}
                  />
                ) : (
                  <select
                    required
                    value={item.tenancyChargesByKaen}
                    onChange={(e) => { onUpdateItem(index, "tenancyChargesByKaen", e.target.value); onClearError(index, "tenancyChargesByKaen"); }}
                    className={inputClassFor("tenancyChargesByKaen")}
                    disabled={kaenChargeOptions.length === 0}
                  >
                    <option value="">
                      {kaenChargeOptions.length === 0 ? "No tiers configured" : "Select amount"}
                    </option>
                    {kaenChargeOptions.map((opt) => (
                      <option key={opt.tier} value={opt.companyMinimum}>
                        RM {Number(opt.companyMinimum).toLocaleString("en-MY")}
                      </option>
                    ))}
                  </select>
                )}
                {!isListingPortion && (
                  kaenChargeOptions.length === 0 ? (
                    <p className="text-xs text-amber-500 mt-1">
                      No TA tiers configured for this org. Contact your admin to set them up in /settings/commission.
                    </p>
                  ) : taTier ? (
                    <p className="text-xs text-emerald-500 mt-1">Tier {taTier.tier} &middot; auto-filled</p>
                  ) : item.monthlyRental && Number(item.monthlyRental) > 0 ? (
                    <p className="text-xs text-amber-500 mt-1">
                      No tier matches RM {item.monthlyRental} — pick a charge manually below.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1">Enter rental to auto-fill</p>
                  )
                )}
                {hasError(index, "tenancyChargesByKaen") && <p className="mt-1 text-xs text-red-500">{getError(index, "tenancyChargesByKaen")}</p>}
              </div>
            </div>

            <div className="border-t border-border/50 pt-4 mt-2 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cobroke (TA split)</p>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={item.hasCobrokeIntent}
                  onChange={(e) => onUpdateItem(index, "hasCobrokeIntent", e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <span className="text-foreground">Cobroke — split TA profit with another agent</span>
              </label>
              {item.hasCobrokeIntent && (
                <div id={`field-${index}-taSharePercent`} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-muted-foreground mb-1">Your TA share % *</label>
                    <input
                      type="number"
                      min={0}
                      max={Number(existingClaimsQuery.data?.remainingTaPct ?? 100)}
                      step="0.01"
                      value={item.taSharePercent}
                      onChange={(e) => onUpdateItem(index, "taSharePercent", e.target.value)}
                      placeholder="100"
                      className={inputClass}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Your share of the TA profit. Can differ from your commission share.
                      {existingClaimsQuery.data?.remainingTaPct != null && ` Max available: ${existingClaimsQuery.data.remainingTaPct}%.`}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Shortfall warning ──────────────────────────────── */}
          {shortfall > 0 && (
            <div className="mt-4 space-y-2">
              <Callout variant="warning" title={`TA Shortfall: RM ${shortfall.toFixed(2)}`}>
                Your commission charged to the tenant is below the KAEN minimum.{" "}
                <span className="font-semibold">RM {shortfallApplied.toFixed(2)}</span>{" "}
                will be deducted from your commission payout.
              </Callout>
              {outstandingBalance > 0 && (
                <Callout variant="danger" title="Commission insufficient">
                  <span className="font-semibold">RM {outstandingBalance.toFixed(2)}</span> outstanding balance will be owed to KAEN.
                </Callout>
              )}
            </div>
          )}
        </div>

        {/* ── Section: Pax (conditional) ───────────────────────── */}
        {item.hasPaxDeduction && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Users className="h-4 w-4 text-amber-600" />
              Pax Deduction
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div id={`field-${index}-numberOfPax`}>
                <label className="block text-sm text-muted-foreground mb-1">Number of Pax *</label>
                <input
                  type="number"
                  min={1}
                  step="1"
                  value={item.numberOfPax}
                  onChange={(e) => { onUpdateItem(index, "numberOfPax", e.target.value); onClearError(index, "numberOfPax"); }}
                  placeholder="e.g. 3"
                  className={inputClassFor("numberOfPax")}
                />
                {hasError(index, "numberOfPax") && <p className="mt-1 text-xs text-red-500">{getError(index, "numberOfPax")}</p>}
              </div>
              {item.paxDeductionAmount > 0 && (
                <div className="text-xs text-muted-foreground self-end pb-2">
                  Deduction: {formatMYR(item.paxDeductionAmount)} per pax
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Section: Remark ──────────────────────────────────── */}
        <RemarkField
          value={item.remark ?? ""}
          onChange={(v) => onUpdateItem(index, "remark", v)}
        />

        {/* ── Section: Calculation Preview ─────────────────────── */}
        {showBreakdown && (
          <div className="rounded-lg border border-border/50 bg-background/40 p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Nett Payout Breakdown</h4>
            <PayoutBreakdown
              monthlyRental={item.monthlyRental}
              numberOfPax={item.numberOfPax}
              paxDeductionAmount={property?.paxDeductionAmount ?? null}
              hasPaxDeduction={Boolean(property?.hasPaxDeduction)}
              tierPercentage={tierPercentage}
              commissionPercentage={item.commissionPercentage}
              tenancyChargesByAgent={item.tenancyChargesByAgent}
              tenancyChargesByKaen={item.tenancyChargesByKaen}
              isCobroke={Boolean(item.hasCobrokeIntent)}
              taSharePercent={item.taSharePercent}
              shortfallApplied={shortfallApplied}
              outstandingBalance={outstandingBalance}
            />
          </div>
        )}
      </CardContent>
    </Card>
    </>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function ClaimItemsTable({
  items,
  claimType,
  selectedProperties,
  tierPercentage,
  hasError,
  getError,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
  onPropertySelect,
  onClearError,
  onBannerData,
}: ClaimItemsTableProps) {
  return (
    <div className="space-y-6">
      {/* ── Claim Items ───────────────────────────────────────────────────── */}
      <div className="space-y-6">
        {items.map((item, index) => {
          const property = selectedProperties.get(item.key);
          return (
            <ClaimItemCard
              key={item.key}
              item={item}
              index={index}
              totalItems={items.length}
              claimType={claimType}
              property={property}
              tierPercentage={tierPercentage}
              hasError={hasError}
              getError={getError}
              onRemoveItem={onRemoveItem}
              onUpdateItem={onUpdateItem}
              onPropertySelect={onPropertySelect}
              onClearError={onClearError}
              onBannerData={onBannerData}
            />
          );
        })}
      </div>

      {/* ── Add Item Button ───────────────────────────────────────────────── */}
      <Button variant="outline" size="lg" onClick={onAddItem} className="w-full border-dashed border-2 h-14 text-base gap-2">
        <Plus className="h-5 w-5" />
        Add Another Item
      </Button>
    </div>
  );
}
