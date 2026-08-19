// Multi-month statement download picker (Task D2) — the UI for D1's streamed-ZIP
// export. A from/to month range + an "Include bills" checkbox + a Download button
// that bundles every POST-only statement in the range into ONE ZIP.
//
// Presentational + dual-surface (mirrors ProofPackPanel): it owns NO data fetching
// and — deliberately — NO ownerPartyId field. The ADMIN mount wires the admin route
// (carrying the workspace's ownerPartyId, baked into its onDownload helper); the
// OWNER PORTAL mount wires the owner-scoped route (owner = the session, never a UI
// field). One picker, two helpers — no duplicated range UI across admin and portal.
//
// Client-side validation MIRRORS D1's server cap (validateExportRange) so the user
// sees the limit BEFORE the request fires: from > to is rejected and a range > 24
// inclusive months DISABLES download with a visible hint (24 months is allowed —
// the server rejects monthSpanInclusive > 24).
import { useState } from "react";
import { Download, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Must match MAX_RANGE_MONTHS in multi-month-export.service.ts (the server's 400 cap). */
const MAX_RANGE_MONTHS = 24;

export interface MultiMonthDownloadParams {
  /** "YYYY-MM" inclusive lower bound. */
  fromMonth: string;
  /** "YYYY-MM" inclusive upper bound. */
  toMonth: string;
  /** Also bundle each month's separate proof pack (bills) into the ZIP. */
  includeProof: boolean;
}

interface Props {
  /**
   * Fires with the chosen range + includeProof flag when the (valid) Download button
   * is clicked. The PARENT performs the authenticated ZIP fetch + browser download:
   * the admin mount adds ownerPartyId; the portal mount uses the session owner.
   */
  onDownload: (params: MultiMonthDownloadParams) => void;
  /** Disables the button + shows progress while the ZIP is being fetched. */
  downloading?: boolean;
  /** Optional heading override (admin vs portal copy). */
  title?: string;
  /** Optional sub-copy under the heading. */
  description?: string;
}

/**
 * Inclusive count of calendar months between two "YYYY-MM" strings (same month ⇒ 1).
 * MIRRORS the server's monthSpanInclusive so the client cap matches the 400 exactly.
 * Returns < 1 when from > to (used to flag the reversed range).
 */
function monthSpanInclusive(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

export function MultiMonthDownload({
  onDownload,
  downloading = false,
  title = "Download a range of statements",
  description = "Bundle every posted monthly statement in a date range into one ZIP.",
}: Props) {
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");
  const [includeProof, setIncludeProof] = useState(false);

  const bothSet = fromMonth !== "" && toMonth !== "";
  const span = bothSet ? monthSpanInclusive(fromMonth, toMonth) : 0;
  const fromAfterTo = bothSet && span < 1;
  const tooWide = bothSet && span > MAX_RANGE_MONTHS;
  const canDownload = bothSet && !fromAfterTo && !tooWide && !downloading;

  function handleDownload() {
    if (!canDownload) return;
    onDownload({ fromMonth, toMonth, includeProof });
  }

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          {title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          {/* div (not label) so getByLabelText only matches via aria-label —
              avoids colliding with owner-workspace's own "From month" filter that
              shares this statements tab. Mirrors the workspace filter's structure. */}
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              From month
            </span>
            <input
              type="month"
              value={fromMonth}
              aria-label="Export range start month"
              data-testid="multi-month-from"
              onChange={(e) => setFromMonth(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              To month
            </span>
            <input
              type="month"
              value={toMonth}
              aria-label="Export range end month"
              data-testid="multi-month-to"
              onChange={(e) => setToMonth(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={includeProof}
              aria-label="Include bills"
              data-testid="multi-month-include-proof"
              onChange={(e) => setIncludeProof(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus:ring-2 focus:ring-ring"
            />
            Include bills
          </label>

          <Button
            variant="gold"
            disabled={!canDownload}
            onClick={handleDownload}
            data-testid="multi-month-download-btn"
            className="ml-auto"
          >
            <Download className="h-4 w-4" />
            {downloading ? "Preparing…" : "Download ZIP"}
          </Button>
        </div>

        {/* Client-side validation hints — surfaced BEFORE the request so the user
            doesn't trip the server's 400. */}
        {fromAfterTo && (
          <p
            role="alert"
            data-testid="multi-month-error"
            className={cn("text-sm font-medium text-rose-600")}
          >
            The From month must be on or before the To month.
          </p>
        )}
        {tooWide && (
          <p
            role="alert"
            data-testid="multi-month-range-hint"
            className={cn("text-sm font-medium text-rose-600")}
          >
            That range is too large — choose {MAX_RANGE_MONTHS} months or fewer.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
