/**
 * Shared expand-panel shell for tenant and owner party drawers.
 *
 * Exports:
 *   `PartyDetailPanel` — skeleton / error / content + Edit-button shell.
 *   `IcRevealField`    — masked-IC field with audited one-time reveal.
 *
 * Tasks 5 (tenant panel) and 6 (owner panel) import these and compose their
 * respective field grids inside `PartyDetailPanel > children`.
 *
 * Design: mirrors the Tenant Tracker expand-panel look — uses `DetailField`
 * for label/value rows, `Button` from ui/button.  No new design language.
 */

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DetailField } from "@/pages/tenancy/tenant-tracker/row-parts";
import { useRevealPartyIc } from "@/api/parties-detail";

// ── PartyDetailPanel ──────────────────────────────────────────────────────────

interface PartyDetailPanelProps {
  loading: boolean;
  error: string | null | undefined;
  children?: React.ReactNode;
  onEdit: () => void;
  editLabel?: string;
}

/**
 * Shell that wraps a party detail grid.
 *
 * - `loading=true`  → animated skeleton (no content, no Edit button).
 * - `error` set     → inline error alert.
 * - Otherwise       → renders `children` in a two-column grid + an Edit button.
 *
 * The `editLabel` defaults to "Edit" so callers can specify "Edit Tenant" /
 * "Edit Owner" without boilerplate.
 */
export function PartyDetailPanel({
  loading,
  error,
  children,
  onEdit,
  editLabel = "Edit",
}: PartyDetailPanelProps) {
  if (loading) {
    return (
      <div
        className="space-y-3 animate-pulse"
        aria-label="Loading details"
      >
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-4 w-48 rounded bg-muted" />
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="h-4 w-36 rounded bg-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">{children}</div>
      <Button variant="outline" size="sm" onClick={onEdit}>
        {editLabel}
      </Button>
    </div>
  );
}

// ── IcRevealField ─────────────────────────────────────────────────────────────

interface IcRevealFieldProps {
  partyId: string;
  masked: string | null;
}

/**
 * Shows the masked IC number (e.g. "••••1234") with a Reveal button.
 *
 * On click → `useRevealPartyIc().mutate({ partyId })` → server audits the
 * access and returns `{ idNumber }` → revealed value replaces the masked
 * display. The revealed value is kept in component-local state only (never
 * enters the React Query cache) and is cleared on unmount.
 *
 * Uses `useRevealPartyIc` from the parties API module, which calls the
 * non-flag-gated `POST /parties/:partyId/ic-reveal` endpoint — works for
 * tenants AND owners via the same `recordIcRevealService`.
 */
export function IcRevealField({ partyId, masked }: IcRevealFieldProps) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const { mutate, isPending } = useRevealPartyIc();

  // Clear the revealed IC from memory when the field unmounts (e.g. drawer
  // closes or the expanded row collapses).
  useEffect(() => {
    return () => {
      setRevealed(null);
    };
  }, []);

  function handleReveal() {
    setRevealError(null);
    mutate(
      { partyId },
      {
        onSuccess: (data) => {
          setRevealed(data.idNumber);
          setRevealError(null);
        },
        onError: () => {
          setRevealError("Could not reveal IC. Please try again.");
        },
      },
    );
  }

  return (
    <DetailField label="IC Number">
      <div className="flex items-center gap-2">
        <span>{revealed ?? masked ?? "—"}</span>
        {!revealed && !!masked && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReveal}
            disabled={isPending}
            aria-label="Reveal"
          >
            {isPending ? "Revealing…" : "Reveal"}
          </Button>
        )}
      </div>
      {revealError && (
        <p className="mt-1 text-xs text-destructive">{revealError}</p>
      )}
    </DetailField>
  );
}
