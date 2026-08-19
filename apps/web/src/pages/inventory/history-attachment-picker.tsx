// Mint-only attachment picker (M7 Task 9) — shared by the resolve-ticket and
// quick-log dialogs. PRESENTATIONAL: the PARENT owns the
// usePhase2AttachmentUpload hook (so submit/reset can reach reset() and
// isUploading) plus the collected-keys state; this renders the pick button,
// per-file progress, pending thumbnails, and local remove-from-list.
import { useEffect, useState, useRef } from "react";
import { FileText, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Phase2UploadItem } from "@/hooks/use-phase2-attachment-upload";

export function HistoryAttachmentPicker({
  items,
  keys,
  onPick,
  onRetry,
  onRemoveKey,
}: {
  items: Phase2UploadItem[];
  keys: string[];
  onPick: (files: FileList) => void;
  onRetry: (id: string) => void;
  /** Local-only: drops the key from the parent's collected list pre-submit. */
  onRemoveKey: (key: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Hide done items whose key the user removed from the pending list.
  const visible = items.filter(
    (i) => i.status !== "done" || (i.storageKey != null && keys.includes(i.storageKey)),
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="w-full rounded-lg border-2 border-dashed border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3 text-center text-sm text-[var(--text-muted)] transition hover:border-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <Upload className="mx-auto mb-1 h-5 w-5" />
        Add photos or PDFs
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onPick(e.target.files);
          // Clear so re-picking the same file fires change again.
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      {visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((item) => (
            <PendingAttachmentRow
              key={item.id}
              item={item}
              onRetry={onRetry}
              onRemoveKey={onRemoveKey}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PendingAttachmentRow({
  item,
  onRetry,
  onRemoveKey,
}: {
  item: Phase2UploadItem;
  onRetry: (id: string) => void;
  onRemoveKey: (key: string) => void;
}) {
  // Object-URL preview owned per row: minted in an effect (not render — refs
  // and side effects are banned there) and revoked on unmount / file change.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    // jsdom doesn't implement createObjectURL — fall back to the icon there.
    if (!item.file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") {
      return;
    }
    const url = URL.createObjectURL(item.file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URLs are external resources; mint-in-effect + revoke-in-cleanup is the supported lifecycle.
    setPreview(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreview(null);
    };
  }, [item.file]);

  return (
    <li className="flex items-center gap-3 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2">
      {preview ? (
        <img src={preview} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
      ) : (
        <FileText className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-[var(--text-primary)]">{item.file.name}</p>
        {item.status !== "done" && (
          <p className="text-xs text-[var(--text-muted)]">
            {item.status === "error"
              ? (item.error ?? "Upload failed.")
              : `Uploading ${item.progress}%`}
          </p>
        )}
      </div>
      {item.status === "error" && (
        <Button type="button" variant="outline" size="xs" onClick={() => onRetry(item.id)}>
          Retry
        </Button>
      )}
      {item.status === "done" && item.storageKey != null && (
        <button
          type="button"
          aria-label={`Remove ${item.file.name}`}
          onClick={() => onRemoveKey(item.storageKey as string)}
          className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-rose-500/10 hover:text-rose-500"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}
