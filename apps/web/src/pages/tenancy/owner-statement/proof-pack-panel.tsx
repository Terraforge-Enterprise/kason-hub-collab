// Bills/Proof panel (Task C2) — the proof-pack's UI counterpart, SEPARATE from the
// clean financial statement. It lists every bill attached to an (owner, month,
// apartment) grouped by category (filename + thumbnail → the shared BillLightbox)
// and offers a single "Download all bills" action (→ the merged proof-pack PDF, C1).
//
// Presentational + dual-surface: it owns NO data fetching. The ADMIN mount wires
// the admin endpoints (useExpenseProofs + the admin proof-pack download + attach/
// detach) and renders it EDITABLE; the OWNER PORTAL mount wires the owner-scoped,
// POST-only endpoints and renders it READ-ONLY (no attach/detach affordance). One
// panel, one viewer — no duplicated bill UI across admin and portal.
import { useState } from "react";
import { Download, Expand, FileText, Paperclip, Receipt, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import type { ExpenseProofGroup, ExpenseProofItem } from "@/api/owner-billing";
import { BillLightbox, isImageFilename } from "./bill-lightbox";

interface Props {
  /** Bills grouped by RAW category — from useExpenseProofs (admin) or the portal proof hook. */
  groups: ExpenseProofGroup[];
  /** While the proofs query is in flight (suppresses the empty state's flash). */
  isLoading?: boolean;
  /**
   * EDITABLE (admin) → per-category attach + per-tile detach affordances. Omitted /
   * false (owner portal) → strictly read-only: bills are viewable but NOT mutable.
   */
  editable?: boolean;
  /** Triggers the (admin or portal) proof-pack download. */
  onDownloadAll: () => void;
  /** Disables the button + shows progress while the pack is being fetched. */
  downloading?: boolean;
  /** Attach handler (editable only). Receives the RAW category key + the chosen files. */
  onAttach?: (category: string, files: File[]) => void;
  attaching?: boolean;
  /** Detach handler (editable only). Receives the proof id to delete. */
  onDetach?: (proofId: string) => void;
  detaching?: boolean;
}

/**
 * Humanise a snake_case RAW category key for display:
 *   "utilities_tnb" → "Utilities Tnb", "fire_insurance" → "Fire Insurance".
 * Mirrors the portal statement page's humaniseCategory.
 */
function humaniseCategory(key: string): string {
  return key
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ProofPackPanel({
  groups,
  isLoading = false,
  editable = false,
  onDownloadAll,
  downloading = false,
  onAttach,
  attaching = false,
  onDetach,
  detaching = false,
}: Props) {
  // Flatten across categories so the lightbox can page prev/next through EVERY bill
  // (the same set the "Download all bills" pack contains), regardless of category.
  const flatProofs = groups.flatMap((g) => g.proofs);
  const indexById = new Map(flatProofs.map((p, i) => [p.id, i] as const));
  const total = flatProofs.length;

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const active = lightboxIndex !== null ? flatProofs[lightboxIndex] : undefined;

  const hasProofs = total > 0;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          Bills &amp; Proof
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasProofs || downloading}
          onClick={onDownloadAll}
          data-testid="download-proof-pack-btn"
        >
          <Download className="h-4 w-4" />
          {downloading ? "Preparing…" : "Download all bills"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-5">
        {!hasProofs ? (
          <EmptyState
            icon={FileText}
            title="No bills attached"
            description={
              editable
                ? "Attach supporting bills per expense in the breakdown above — they'll be collected here as one downloadable proof pack."
                : "Supporting bills for this statement haven't been provided yet. They'll appear here once your property manager attaches them."
            }
          />
        ) : (
          groups.map((group) => (
            <ProofCategoryGroup
              key={group.category}
              category={group.category}
              proofs={group.proofs}
              editable={editable}
              attaching={attaching}
              detaching={detaching}
              onOpen={(id) => setLightboxIndex(indexById.get(id) ?? null)}
              onAttach={onAttach}
              onDetach={onDetach}
            />
          ))
        )}

        {isLoading && !hasProofs && (
          <p className="text-sm text-muted-foreground">Loading bills…</p>
        )}
      </CardContent>

      <BillLightbox
        open={lightboxIndex !== null && Boolean(active?.url)}
        index={lightboxIndex}
        total={total}
        url={active?.url}
        label={active?.filename ?? ""}
        isImage={active ? isImageFilename(active.filename) : false}
        onClose={() => setLightboxIndex(null)}
        onPrev={() => setLightboxIndex((i) => (i === null ? null : (i - 1 + total) % total))}
        onNext={() => setLightboxIndex((i) => (i === null ? null : (i + 1) % total))}
      />
    </Card>
  );
}

// ─── One category's bills ────────────────────────────────────────────────────

function ProofCategoryGroup({
  category,
  proofs,
  editable,
  attaching,
  detaching,
  onOpen,
  onAttach,
  onDetach,
}: {
  category: string;
  proofs: ExpenseProofItem[];
  editable: boolean;
  attaching: boolean;
  detaching: boolean;
  onOpen: (proofId: string) => void;
  onAttach?: (category: string, files: File[]) => void;
  onDetach?: (proofId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {humaniseCategory(category)}
        </p>
        {editable && (
          <ProofAttachButton category={category} attaching={attaching} onAttach={onAttach} />
        )}
      </div>

      <ul className="space-y-2">
        {proofs.map((p) => (
          <li key={p.id} className="flex items-center gap-3">
            <ProofTile proof={p} onOpen={() => onOpen(p.id)} />
            <span
              className="min-w-0 flex-1 truncate text-sm text-foreground"
              title={p.filename}
            >
              {p.filename}
            </span>
            {editable && !p.readOnly && (
              <button
                type="button"
                aria-label={`Detach ${p.filename}`}
                disabled={detaching}
                onClick={() => onDetach?.(p.id)}
                className="rounded-md border border-border/60 bg-background p-1 text-muted-foreground shadow-sm transition hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One bill tile: image key → thumbnail, else a file icon; opens the shared lightbox. */
function ProofTile({ proof, onOpen }: { proof: ExpenseProofItem; onOpen: () => void }) {
  const image = isImageFilename(proof.filename);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Preview ${proof.filename}`}
      title={proof.filename}
      className="group relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40 transition hover:border-[var(--gold)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      {image ? (
        <img
          src={proof.url}
          alt={proof.filename}
          loading="lazy"
          decoding="async"
          className="h-10 w-10 rounded object-cover"
        />
      ) : (
        <FileText className="h-4 w-4 text-muted-foreground" />
      )}
      <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/40 text-white group-hover:flex">
        <Expand className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

/** Per-category attach affordance (editable/admin only). Posts RAW category + files. */
function ProofAttachButton({
  category,
  attaching,
  onAttach,
}: {
  category: string;
  attaching: boolean;
  onAttach?: (category: string, files: File[]) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition",
        "hover:border-[var(--gold)] hover:text-foreground",
        attaching && "cursor-not-allowed opacity-60",
      )}
    >
      <Paperclip className="h-3.5 w-3.5" />
      {attaching ? "Uploading…" : "Add bill"}
      <input
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        disabled={attaching}
        data-testid={`proof-pack-attach-${category}`}
        onChange={(e) => {
          const list = e.target.files;
          if (list && list.length > 0) onAttach?.(category, Array.from(list));
          e.target.value = "";
        }}
      />
    </label>
  );
}
