// BulkBillAttach — bulk per-unit bill upload + list + detach (Task 7 / D2).
//
// Drops MANY supporting bills at once for a (ownerPartyId, month, apartmentId).
// Uses the existing POST /owner-billing/expense-proofs endpoint with a shared
// BULK_PROOF_CATEGORY = "supporting" — no new endpoint, no schema change.
//
// DESIGN: matches the ReceiptUploader dropzone look/UX (same dashed border, same
// hover/active states, same UploadCloud icon, same tile fallback). Lists already-
// attached "supporting" bills with a Remove button for no-orphan cleanup.
//
// The statement-page ExpenseBreakdown proof panel groups proofs by RAW category —
// a "supporting" group renders gracefully as "Supporting documents" via the same
// proofsByCategory.get(category) path; no crash, no mislabel possible.

import { useRef, useState } from "react";
import { FileText, Paperclip, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useAttachExpenseProof,
  useDetachExpenseProof,
  useExpenseProofs,
  type ExpenseProofItem,
} from "@/api/owner-billing";

// ─── Shared constant ─────────────────────────────────────────────────────────
// Only web consumers need this (API takes any free-string category).
// Keep here rather than @kason/shared to avoid triggering a dist rebuild.
export const BULK_PROOF_CATEGORY = "supporting";

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  ownerPartyId: string;
  /** "YYYY-MM" */
  month: string;
  apartmentId: string;
}

export function BulkBillAttach({ ownerPartyId, month, apartmentId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const proofsQuery = useExpenseProofs(ownerPartyId, month, apartmentId);
  // Find the "supporting" group (may not exist when no bills are attached yet).
  const groups = proofsQuery.data?.data ?? [];
  const supportingGroup = groups.find((g) => g.category === BULK_PROOF_CATEGORY);
  const proofs: ExpenseProofItem[] = supportingGroup?.proofs ?? [];

  const scope = { ownerPartyId, statementMonth: month, apartmentId };

  const attach = useAttachExpenseProof();
  const detach = useDetachExpenseProof();

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    attach.mutate(
      { ...scope, category: BULK_PROOF_CATEGORY, files: Array.from(list) },
      {
        onSuccess: (rows) =>
          toast.success(rows.length === 1 ? "Bill attached." : `${rows.length} bills attached.`),
        onError: (err: Error) => toast.error(err.message),
      },
    );
  }

  function detachProof(id: string) {
    detach.mutate(id, {
      onSuccess: () => toast.success("Bill detached."),
      onError: (err: Error) => toast.error(err.message),
    });
  }

  return (
    <div className="space-y-3">
      {/* Dropzone — matches ReceiptUploader styling */}
      <button
        type="button"
        aria-label="Upload supporting bills"
        disabled={attach.isPending}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-all",
          "border-border/60 bg-background/40 hover:bg-background/60 hover:border-border",
          dragOver && "border-[var(--gold)] bg-amber-500/5",
          attach.isPending && "cursor-not-allowed opacity-60",
        )}
      >
        <UploadCloud className="h-6 w-6 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {attach.isPending ? "Uploading…" : "Click or drop bills to upload"}
        </span>
        <span className="text-xs text-muted-foreground">
          All dropped files are stored as supporting documents for this unit + month.
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Attached bills list */}
      {proofs.length > 0 ? (
        <ul className="space-y-1.5" data-testid="bulk-proof-list">
          {proofs.map((proof) => (
            <BillRow
              key={proof.id}
              proof={proof}
              detaching={detach.isPending}
              onRemove={() => detachProof(proof.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No supporting bills attached yet.</p>
      )}
    </div>
  );
}

// ─── Bill row ─────────────────────────────────────────────────────────────────

const PDF_EXT_RE = /\.pdf$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;

function BillRow({
  proof,
  detaching,
  onRemove,
}: {
  proof: ExpenseProofItem;
  detaching: boolean;
  onRemove: () => void;
}) {
  const isImage = IMAGE_EXT_RE.test(proof.filename);
  const isPdf = PDF_EXT_RE.test(proof.filename);

  return (
    <li className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2">
      {/* Icon */}
      <span className="shrink-0 text-muted-foreground">
        {isImage ? (
          <img
            src={proof.url}
            alt={proof.filename}
            loading="lazy"
            decoding="async"
            className="h-6 w-6 rounded object-cover"
          />
        ) : isPdf ? (
          <FileText className="h-4 w-4" />
        ) : (
          <Paperclip className="h-4 w-4" />
        )}
      </span>

      {/* Filename — links open in new tab for quick preview */}
      <a
        href={proof.url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
        title={proof.filename}
      >
        {proof.filename}
      </a>

      {/* Remove button */}
      <button
        type="button"
        aria-label={`Remove ${proof.filename}`}
        disabled={detaching}
        onClick={onRemove}
        className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-50"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
