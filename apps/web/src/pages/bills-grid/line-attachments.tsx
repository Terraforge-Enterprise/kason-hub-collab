// T1 Task 5 — per-EXPENSE-LINE attachments control.
//
// Mirrors attachments-panel.tsx (the entry-level owner panel) verbatim in its
// fail-closed mutation wiring, per-file Retry Callout, manager-gated delete row
// and the deleteFailedId-on-502 inline Retry — with exactly three deltas for a
// single expense LINE:
//  1. It lists/uploads by `expenseId` (query key ["bills-grid","line-attachments",
//     expenseId]) not (apartmentId, periodMonth), and the list query is
//     `enabled: !!expenseId` — an unsaved line (null id) fires no list.
//  2. A1 auto-save-on-attach: on an unsaved line the upload handler first calls
//     `onEnsurePersisted()` to single-create the line and obtain its id; it
//     uploads ONLY if that id is non-null (a failed/blocked persist aborts the
//     upload — the guard `if (!id) return`).
//  3. Upload is disabled when a mutation is in flight OR the line is unsaved and
//     not yet valid to persist (`!expenseId && !canUpload`); `uploadHint` renders
//     in that disabled-for-invalid case.
//
// Delete REUSES the existing manager-gated `deleteAttachment(apartmentId, id)`
// route unchanged (an attachment id alone identifies both the row and the
// object). No new delete surface.
//
// The two fail-closed rules are inherited from attachments-panel.tsx unchanged:
// upload writes a DB row server-side ONLY after a confirmed 2xx (this component
// NEVER optimistically appends — onError never touches the cache; only success
// invalidates), and delete is object-first fail-closed server-side (a 502
// ATTACHMENT_DELETE_FAILED retains the row; the client mirrors by never
// optimistically removing and showing an inline per-row Retry on that 502).
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Paperclip, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ApiError } from "@/lib/api-client";
import {
  deleteAttachment,
  getAttachmentUrl,
  listLineAttachments,
  uploadLineAttachments,
  GRID_QUERY_KEY_ROOT,
  type AttachmentListItem,
} from "@/api/bills-grid";
import { BillLightbox, isImageFilename } from "@/pages/tenancy/owner-statement/bill-lightbox";

export type LineAttachmentsProps = {
  expenseId: string | null; // null = row not yet persisted
  apartmentId: string; // for the reused manager DELETE route
  canUpload: boolean; // A1 precondition; only consulted when expenseId is null
  uploadHint: string | null; // shown when Upload is disabled-for-invalid
  isManager: boolean;
  onEnsurePersisted: () => Promise<string | null>; // single-create the line, return new id (or null if it couldn't persist)
};

export function LineAttachments({
  expenseId,
  apartmentId,
  canUpload,
  uploadHint,
  isManager,
  onEnsurePersisted,
}: LineAttachmentsProps) {
  const queryClient = useQueryClient();
  // Per-line key — distinct from the panel's (apartmentId, periodMonth) key so a
  // line's list can't collide with the entry-level month list.
  const queryKey = ["bills-grid", "line-attachments", expenseId];
  const inputRef = useRef<HTMLInputElement | null>(null);

  const listQuery = useQuery({
    queryKey,
    // A non-null assertion is safe: `enabled` short-circuits the fn when null.
    queryFn: () => listLineAttachments(expenseId as string),
    enabled: !!expenseId, // an unsaved line fires no list
  });
  const items = listQuery.data?.items ?? [];

  // Item 4 — inline preview (mirrors attachments-panel.tsx): clicking a filename
  // opens BillLightbox (image → <img>, PDF → <iframe>); prev/next cycle the list.
  // The signed URL is minted lazily per active attachment (short-lived).
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const activeItem = previewIndex !== null ? (items[previewIndex] ?? null) : null;
  const previewQuery = useQuery({
    queryKey: ["bills-grid", "attachment-url", activeItem?.id],
    queryFn: () => getAttachmentUrl(activeItem!.id),
    enabled: activeItem != null,
  });
  // Review #3: a failed URL fetch (e.g. the row was deleted between list-render
  // and click → 404) must not leave an open-but-blank viewer with no cue. Toast
  // and close instead of rendering an empty lightbox.
  useEffect(() => {
    if (previewQuery.isError && previewIndex !== null) {
      toast.error("Couldn't open the attachment.");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a query-result transition (preview-URL fetch error) with a toast + viewer-close; there is no non-effect place to observe this async settle.
      setPreviewIndex(null);
    }
  }, [previewQuery.isError, previewIndex]);

  // Retained ONLY so "Retry" can resubmit the exact same file set — never read to
  // decide what renders (the row list above is server-truth only).
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);

  const uploadMutation = useMutation({
    // A1: on an unsaved line resolve the id via onEnsurePersisted first, and
    // upload ONLY if it returned a non-null id — a blocked/failed persist aborts
    // (the `if (!id) return` guard) so no upload can target a non-existent line.
    mutationFn: async (files: File[]) => {
      const id = expenseId ?? (await onEnsurePersisted());
      if (!id) return;
      await uploadLineAttachments(id, files);
    },
    onSuccess: () => {
      setPendingFiles(null);
      toast.success("File uploaded.");
      queryClient.invalidateQueries({ queryKey }); // this line's own key
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT }); // R6: refresh grid cell/badge
    },
    onError: (_err: unknown, files: File[]) => {
      setPendingFiles(files);
    },
  });

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    uploadMutation.mutate(Array.from(list));
  }

  // Set on a 502 ATTACHMENT_DELETE_FAILED for a specific row — distinct from a
  // toast because the row itself must stay visible with an inline Retry.
  const [deleteFailedId, setDeleteFailedId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: string) => deleteAttachment(apartmentId, attachmentId),
    onSuccess: (_data: { ok: true }, attachmentId: string) => {
      if (deleteFailedId === attachmentId) setDeleteFailedId(null);
      toast.success("Attachment removed.");
      queryClient.invalidateQueries({ queryKey }); // this line's own key
      queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT }); // R6: refresh grid cell/badge
    },
    onError: (err: unknown, attachmentId: string) => {
      if (err instanceof ApiError && err.status === 502) {
        setDeleteFailedId(attachmentId);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    },
  });

  // Disabled while a mutation is in flight OR the line is unsaved and not yet
  // valid to persist. `canUpload` is consulted ONLY for the unsaved case — once
  // expenseId exists the line is persisted and always uploadable.
  const disabledForInvalid = !expenseId && !canUpload;
  const uploadDisabled = uploadMutation.isPending || disabledForInvalid;

  return (
    <div className="space-y-2">
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

      <div className="flex items-center gap-2">
        <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
        <Button
          type="button"
          variant="gold"
          size="xs"
          disabled={uploadDisabled}
          onClick={() => inputRef.current?.click()}
          className="gap-2"
        >
          <UploadCloud className="h-3.5 w-3.5" />
          {uploadMutation.isPending ? "Uploading…" : "Upload"}
        </Button>
      </div>

      {disabledForInvalid && uploadHint && (
        <p className="text-xs text-muted-foreground">{uploadHint}</p>
      )}

      {uploadMutation.isError && (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-3">
            <span>Upload failed — Retry</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => pendingFiles && uploadMutation.mutate(pendingFiles)}
            >
              Retry
            </Button>
          </div>
        </Callout>
      )}

      {items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <AttachmentRow
              key={item.id}
              item={item}
              isManager={isManager}
              deleting={deleteMutation.isPending && deleteMutation.variables === item.id}
              deleteFailed={deleteFailedId === item.id}
              onPreview={() => setPreviewIndex(index)}
              onDelete={() => deleteMutation.mutate(item.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No attachments yet.</p>
      )}

      <BillLightbox
        open={activeItem != null}
        index={previewIndex}
        total={items.length}
        url={previewQuery.data?.downloadUrl}
        label={activeItem?.filename ?? ""}
        isImage={activeItem ? activeItem.contentType.startsWith("image/") || isImageFilename(activeItem.filename) : false}
        onClose={() => setPreviewIndex(null)}
        onPrev={() => setPreviewIndex((i) => (i === null ? null : (i - 1 + items.length) % items.length))}
        onNext={() => setPreviewIndex((i) => (i === null ? null : (i + 1) % items.length))}
      />
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────
// Mirrors attachments-panel.tsx's AttachmentRow: icon + filename + a right-
// aligned action. Delete is `isManager`-gated — the control is ABSENT for an
// editor, not merely disabled (R26).

function AttachmentRow({
  item,
  isManager,
  deleting,
  deleteFailed,
  onPreview,
  onDelete,
}: {
  item: AttachmentListItem;
  isManager: boolean;
  deleting: boolean;
  deleteFailed: boolean;
  onPreview: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={onPreview}
          title={`Preview ${item.filename}`}
          className="min-w-0 flex-1 truncate text-left text-sm text-foreground underline-offset-2 hover:text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded"
        >
          {item.filename}
        </button>
        {isManager && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Delete ${item.filename}`}
            disabled={deleting}
            onClick={onDelete}
            className="text-rose-600 hover:text-rose-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {deleteFailed && (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-3">
            <span>Couldn&apos;t remove file — Retry</span>
            <Button type="button" variant="outline" size="sm" onClick={onDelete}>
              Retry
            </Button>
          </div>
        </Callout>
      )}
    </li>
  );
}
