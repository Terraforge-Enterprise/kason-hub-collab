/**
 * Billing-schedule drawer — the compact, work-surface view of DraftConfig.
 *
 * Deliberately NOT a second copy of Settings → Billing Config. It exposes only the
 * fields an admin needs while standing in the approvals queue (draft day, which
 * month gets billed, the auto-bill day, active), PATCHes the SAME DraftConfig row
 * through the SAME endpoint, and leaves the include-toggles + due-day offset to
 * the settings page. Progressive disclosure: one source of truth, two levels of
 * detail.
 *
 * The preview sentence is the point of the whole drawer — "on day 25, drafts
 * invoices for next month" is the sentence whose absence made the 25th silently
 * draft the month that was already ending.
 *
 * ⚠️ TWO DAYS, TWO DIFFERENT ACTS. Keep them visibly distinct here, because
 * conflating them is precisely the confusion this drawer exists to prevent:
 *   • DRAFT day  — the invoice is created. Nobody owes anything; the tenant
 *                  cannot see it. This day alone bills NO ONE.
 *   • AUTO-BILL  — the draft is approved: charges post as live receivables,
 *     day       documents issue, the tenant sees an amount payable. Optional;
 *                  off means a human clicks "Issue all" instead.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Play, RefreshCw } from "lucide-react";
import {
  AUTO_BILL_DAY_MAX,
  AUTO_BILL_DAY_MIN,
  BILL_PERIOD_CHOICES,
  addMonthsToYm,
  describeBillPeriodOffset,
} from "@kason/shared";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, RadioField, TextInput } from "@/components/form-ui";
import { apiFetch, ApiError } from "@/lib/api-client";

// ─── Types + query keys (shared with the settings section's endpoint) ──────────

export type DraftBillingConfig = {
  id: string;
  runDayOfMonth: number;
  billPeriodOffset: number;
  /** Day drafts are auto-BILLED. null = off; a human issues from the queue. */
  autoBillDayOfMonth: number | null;
  dueDayOffset: number | null;
  includeRent: boolean;
  includeElectricity: boolean;
  includeMgmtFee: boolean;
  includeCleaning: boolean;
  isActive: boolean;
  autoApprove: boolean;
  updatedAt: string;
};

export const DRAFT_CONFIG_QK = ["billing", "draft-config"] as const;

/** 404 ⇒ "no config yet", which is a legitimate empty state, not an error. */
export async function fetchDraftConfigOrNull(): Promise<DraftBillingConfig | null> {
  try {
    return await apiFetch<DraftBillingConfig>("/billing/draft-config");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function useDraftConfig() {
  return useQuery<DraftBillingConfig | null, ApiError>({
    queryKey: DRAFT_CONFIG_QK,
    queryFn: fetchDraftConfigOrNull,
  });
}

/** "YYYY-MM" for today, local — the month the admin is standing in. */
export function currentYm(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** The period a run started today would draft, per the org's offset. */
export function targetPeriodFor(config: Pick<DraftBillingConfig, "billPeriodOffset"> | null): string {
  return addMonthsToYm(currentYm(), config?.billPeriodOffset ?? 1);
}

/** "Aug 2026" for a "YYYY-MM" — the label used in every preview sentence. */
export function formatYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-MY", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ─── The drawer ───────────────────────────────────────────────────────────────

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: DraftBillingConfig | null;
  /** Admin-only; a manager sees the schedule read-only. */
  canWrite: boolean;
};

export function BillingScheduleSheet({ open, onOpenChange, config, canWrite }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {/* Remount the form per open + per config revision so its state initialises
            from the freshest server values. A `key` does this declaratively; seeding
            with an effect would cascade renders (and trip react-hooks lint). An
            abandoned edit can therefore never leak into the next open. */}
        <ScheduleForm
          key={`${open}:${config?.id ?? "new"}:${config?.updatedAt ?? "none"}`}
          onOpenChange={onOpenChange}
          config={config}
          canWrite={canWrite}
        />
      </SheetContent>
    </Sheet>
  );
}

function ScheduleForm({
  onOpenChange,
  config,
  canWrite,
}: Omit<Props, "open">) {
  const qc = useQueryClient();
  const [runDay, setRunDay] = useState(() => String(config?.runDayOfMonth ?? 25));
  const [offset, setOffset] = useState(() => config?.billPeriodOffset ?? 1);
  const [isActive, setIsActive] = useState(() => config?.isActive ?? true);
  // Auto-billing is two controls over one nullable column: the checkbox decides
  // null-vs-number, the input holds the number. Keeping the day's text while the
  // checkbox is off means an admin who unticks and reticks does not lose what
  // they typed — the saved value is derived at submit time, not on every toggle.
  const [autoBillOn, setAutoBillOn] = useState(() => config?.autoBillDayOfMonth != null);
  const [autoBillDay, setAutoBillDay] = useState(() =>
    String(config?.autoBillDayOfMonth ?? 1),
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        runDayOfMonth: Number(runDay),
        billPeriodOffset: offset,
        autoBillDayOfMonth: autoBillOn ? Number(autoBillDay) : null,
        isActive,
      };
      if (config) {
        return apiFetch<DraftBillingConfig>(`/billing/draft-config/${config.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...body, expectedUpdatedAt: config.updatedAt }),
        });
      }
      // No row yet — the first save creates it, so the admin never has to visit
      // Settings just to bring the schedule into existence.
      return apiFetch<DraftBillingConfig>("/billing/draft-config", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(DRAFT_CONFIG_QK, data);
      toast.success(
        `Schedule saved — drafts on day ${data.runDayOfMonth} for ${describeBillPeriodOffset(data.billPeriodOffset)}, ` +
          (data.autoBillDayOfMonth == null
            ? "billed manually from this queue."
            : `billed automatically on day ${data.autoBillDayOfMonth}.`),
      );
      onOpenChange(false);
    },
    onError: (err: ApiError) => {
      toast.error(
        err.status === 409
          ? "Schedule changed since you opened it — reopen to see the latest."
          : err.message,
      );
    },
  });

  const parsedDay = Number(runDay);
  const dayValid = Number.isInteger(parsedDay) && parsedDay >= 1 && parsedDay <= 28;
  const parsedBillDay = Number(autoBillDay);
  const billDayValid =
    Number.isInteger(parsedBillDay) &&
    parsedBillDay >= AUTO_BILL_DAY_MIN &&
    parsedBillDay <= AUTO_BILL_DAY_MAX;
  // An invalid bill day only blocks saving while auto-billing is actually ON —
  // otherwise the field is not being saved at all and must not hold the form
  // hostage over a value the API will never see.
  const canSave = dayValid && (!autoBillOn || billDayValid);
  // Preview uses the FORM's offset, not the saved one, so the sentence tracks the
  // control the admin is actually moving.
  const previewPeriod = addMonthsToYm(currentYm(), offset);

  return (
    <>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-primary" />
            Billing schedule
          </SheetTitle>
          <SheetDescription>
            When drafts are generated, and which month they bill. Charge inclusions and
            the due-date offset live in Settings → Billing Config.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          <div className="space-y-4">
            <Field
              label="Draft day of month (1–28)"
              hint="The day invoices are CREATED. Creating a draft bills nobody — capped at 28 so it fires in every month, February included."
            >
              <TextInput
                type="number"
                min={1}
                max={28}
                value={runDay}
                disabled={!canWrite}
                onChange={(e) => setRunDay(e.target.value)}
                aria-invalid={!dayValid}
              />
            </Field>

            <RadioField
              label="Bill period"
              hint="KAEN issues on the 25th for the coming month — that is “Next month”."
              value={offset}
              disabled={!canWrite}
              onChange={setOffset}
              options={BILL_PERIOD_CHOICES}
            />

            {/* ── Auto-bill: the act that actually charges people ───────────── */}
            <div className="space-y-3 rounded-lg border border-border/50 bg-background/40 p-4">
              <label className="flex cursor-pointer items-start justify-between gap-4">
                <span className="space-y-1">
                  <span className="block text-sm font-medium text-foreground">
                    Auto-bill drafts on a set day
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Off means every draft waits for an admin to issue it from this queue.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--primary)]"
                  checked={autoBillOn}
                  disabled={!canWrite}
                  onChange={(e) => setAutoBillOn(e.target.checked)}
                />
              </label>

              {autoBillOn ? (
                <Field
                  label={`Auto-bill day of month (${AUTO_BILL_DAY_MIN}–${AUTO_BILL_DAY_MAX})`}
                  hint="From this day onward, that month's drafts are billed without anyone clicking — including a tenant who moves in later in the month."
                >
                  <TextInput
                    type="number"
                    min={AUTO_BILL_DAY_MIN}
                    max={AUTO_BILL_DAY_MAX}
                    value={autoBillDay}
                    disabled={!canWrite}
                    onChange={(e) => setAutoBillDay(e.target.value)}
                    aria-invalid={!billDayValid}
                  />
                </Field>
              ) : null}
            </div>

            {/* The sentence that keeps the schedule honest. It has to describe BOTH
                acts, because "drafts invoices" alone is what let an admin believe
                the run day was the day tenants got billed. */}
            <Callout variant="info" title="What will happen">
              {dayValid ? (
                <>
                  <p>
                    On day {parsedDay} each month, KAEN <strong>drafts</strong> invoices for{" "}
                    <strong>{describeBillPeriodOffset(offset)}</strong>. Run today, that is{" "}
                    <strong>{formatYm(previewPeriod)}</strong>. Nobody is charged yet.
                  </p>
                  <p className="mt-2">
                    {autoBillOn && billDayValid ? (
                      <>
                        From day {parsedBillDay} onward, those drafts are{" "}
                        <strong>billed automatically</strong> — charges go live, documents
                        are issued, and tenants see the amount payable. No one has to click.
                      </>
                    ) : autoBillOn ? (
                      <>
                        Enter an auto-bill day between {AUTO_BILL_DAY_MIN} and{" "}
                        {AUTO_BILL_DAY_MAX} to see when they will be billed.
                      </>
                    ) : (
                      <>
                        They are <strong>not billed</strong> until an admin issues them from
                        this queue.
                      </>
                    )}
                  </p>
                </>
              ) : (
                <>Enter a draft day between 1 and 28 to see what will happen.</>
              )}
            </Callout>

            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border/50 bg-background/40 px-4 py-3">
              <span className="text-sm text-foreground">Active (schedule is live)</span>
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
                checked={isActive}
                disabled={!canWrite}
                onChange={(e) => setIsActive(e.target.checked)}
              />
            </label>

            {/* Drafting is not issuing — say so, because the queue's Approve step is
                what turns these into live receivables. When auto-billing is ON that
                statement becomes FALSE, so the callout must switch rather than sit
                there reassuring an admin who has just removed the human gate. */}
            {autoBillOn ? (
              <Callout variant="warning" title="This bills tenants without a human check">
                On the auto-bill day, charges post as live receivables and tenants see
                what they owe — with nobody reviewing the amounts first. Anything wrong
                in a draft goes out as a real bill. No email is sent by this step;
                correcting a billed invoice means a credit note, not a delete.
              </Callout>
            ) : (
              <Callout variant="warning" title="Drafts only">
                Nothing is sent to tenants automatically. Every draft still needs an admin
                to approve it in this queue, which is when its charges go live.
              </Callout>
            )}
          </div>
        </SheetBody>

        <SheetFooter>
          {canWrite ? (
            <Button
              variant="gold"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !canSave}
            >
              {saveMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  {config ? "Save schedule" : "Create schedule"}
                </>
              )}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {canWrite ? "Cancel" : "Close"}
          </Button>
        </SheetFooter>
    </>
  );
}
