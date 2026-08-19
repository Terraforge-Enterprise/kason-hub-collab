// Shared Phase-2 attachments panel (M7): drop zone + upload queue + thumbnails
// grid + remove-confirm + image lightbox. Extracted from pages/tasks/
// task-attachments.tsx when the ticket drawer needed a byte-identical copy.
// Mirrors the listing-media-panel conventions (drop zone, queue rows,
// hand-rolled fixed-inset lightbox).
//
// PRESENTATIONAL ONLY — callers own the hooks (signed-url query, remove
// mutation, usePhase2AttachmentUpload against THEIR mint/complete endpoints)
// and pass the results in. See pages/tasks/task-attachments.tsx and the
// TicketAttachments wrapper in pages/inventory/ticket-drawer.tsx.
import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, FileText, Trash2, Upload, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import type { AttachmentUrl } from "@/api/tasks";
import type { usePhase2AttachmentUpload } from "@/hooks/use-phase2-attachment-upload";

export function AttachmentsPanel({
  entries,
  fallbackKeys,
  upload,
  onRemove,
  readOnly = false,
  noun = "record",
}: {
  /** Signed-url rows once the download-urls query resolves; undefined while in flight. */
  entries: AttachmentUrl[] | undefined;
  /** Initial/fallback key order (the parent row's attachmentKeys). */
  fallbackKeys: string[];
  /** The caller's upload-queue hook, wired to its own mint/complete endpoints. */
  upload: ReturnType<typeof usePhase2AttachmentUpload>;
  /** Fired AFTER the remove ConfirmAlert is confirmed. */
  onRemove: (key: string) => void;
  /** Hides the drop zone, queue, and per-tile remove — files stay visible. */
  readOnly?: boolean;
  /** "task" | "ticket" — names the parent in the remove-confirm copy. */
  noun?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null);
  const viewable = (entries ?? []).filter((e) => e.kind === "image" || e.kind === "video");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const activeEntry = lightboxIndex === null ? null : viewable[lightboxIndex] ?? null;
  // base-ui Dialog owns Esc/scroll-lock/focus; we add only ←/→ navigation.
  useEffect(() => {
    if (lightboxIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft")
        setLightboxIndex((i) => (i === null ? null : (i - 1 + viewable.length) % viewable.length));
      else if (e.key === "ArrowRight")
        setLightboxIndex((i) => (i === null ? null : (i + 1) % viewable.length));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, viewable.length]);

  const entryByKey = new Map<string, AttachmentUrl>((entries ?? []).map((e) => [e.key, e]));

  // Render from the server's url list once loaded — it's invalidated after
  // every upload-complete, so newly uploaded files appear without waiting for
  // the parent row to refetch. The fallback is the initial order.
  const keys = entries ? entries.map((e) => e.key) : fallbackKeys;

  return (
    <div className="space-y-4">
      {/* Drop zone / add-files button */}
      {!readOnly && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Add attachments"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length > 0) upload.enqueue(e.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
            dragOver
              ? "border-[var(--gold)] bg-[var(--gold)]/5"
              : "border-[var(--card-border)] bg-[var(--card-bg)] hover:border-[var(--text-muted)]"
          }`}
        >
          <Upload className="h-6 w-6 mx-auto mb-2 text-[var(--text-muted)]" />
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Drop files here, or click to browse
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Images / PDFs up to 15 MB · videos up to 50 MB
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) upload.enqueue(e.target.files);
              // Clear so re-picking the same file fires change again.
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
        </div>
      )}

      {/* Upload queue with per-item progress */}
      {!readOnly && upload.items.length > 0 && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)]">
          <div className="px-4 py-2 border-b border-[var(--border)] text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Upload queue
          </div>
          <ul>
            {upload.items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm text-[var(--text-primary)]">{item.file.name}</p>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuenow={item.progress}
                    aria-valuemax={100}
                    aria-label={`Upload progress for ${item.file.name}`}
                    className="mt-1 h-1.5 rounded-full bg-[var(--border)] overflow-hidden"
                  >
                    <div
                      className={`h-full rounded-full transition-all ${
                        item.status === "error"
                          ? "bg-rose-500"
                          : item.status === "done"
                            ? "bg-emerald-500"
                            : "bg-[var(--gold)]"
                      }`}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {item.status === "queued" && "Waiting…"}
                    {item.status === "requesting" && "Requesting upload URL…"}
                    {item.status === "uploading" && `Uploading ${item.progress}%`}
                    {item.status === "completing" && "Finalising…"}
                    {item.status === "done" && "Done."}
                    {item.status === "error" && (item.error ?? "Upload failed.")}
                  </p>
                </div>
                {item.status === "error" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => upload.retry(item.id)}
                  >
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Thumbnails grid */}
      {keys.length > 0 ? (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
            Attachments ({keys.length})
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {keys.map((key) => {
              const entry = entryByKey.get(key);
              return (
                <div
                  key={key}
                  className="group relative aspect-square rounded-md overflow-hidden border border-[var(--border)] bg-muted/40"
                >
                  {!entry ? (
                    <div className="h-full w-full animate-pulse bg-muted/60" />
                  ) : entry.kind === "image" ? (
                    <button
                      type="button"
                      aria-label="View image"
                      onClick={() => setLightboxIndex(viewable.findIndex((v) => v.key === entry.key))}
                      className="h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      <img
                        src={entry.thumbnail ?? entry.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ) : entry.kind === "video" ? (
                    <button
                      type="button"
                      aria-label="View video"
                      onClick={() => setLightboxIndex(viewable.findIndex((v) => v.key === entry.key))}
                      className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      <Video className="h-6 w-6" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider">
                        video
                      </span>
                    </button>
                  ) : (
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                      aria-label="Open PDF"
                    >
                      <FileText className="h-6 w-6" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider">
                        {entry.kind}
                      </span>
                    </a>
                  )}
                  {/* Linked entries belong to the paired entity — labelled, never removable here. */}
                  {entry?.linkedFrom && (
                    <span className="absolute top-1 left-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                      {entry.linkedFrom}
                    </span>
                  )}
                  {!readOnly && !entry?.linkedFrom && (
                    <button
                      type="button"
                      aria-label="Remove attachment"
                      onClick={() => setConfirmRemoveKey(key)}
                      className="absolute top-1 right-1 rounded-md bg-black/50 p-1.5 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition hover:bg-rose-500/80"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        readOnly && <p className="text-xs text-[var(--text-muted)] italic">No attachments.</p>
      )}

      <ConfirmAlert
        open={confirmRemoveKey !== null}
        onCancel={() => setConfirmRemoveKey(null)}
        onConfirm={() => {
          const key = confirmRemoveKey;
          setConfirmRemoveKey(null);
          if (!key) return;
          onRemove(key);
        }}
        title="Remove attachment?"
        body={`The file stays in storage but will no longer appear on this ${noun}. This can't be undone from the UI.`}
        confirmLabel="Remove"
        destructive
      />

      {/* Lightbox — a base-ui Dialog so it joins the app's modal stack and renders
          reliably ABOVE the open Sheet drawer. (A hand-rolled createPortal lightbox
          flickered/unmounted inside the drawer because the Sheet's modal focus-
          management fought it.) base-ui owns Esc, scroll-lock, focus + stacking. */}
      <DialogPrimitive.Root open={lightboxIndex !== null} onOpenChange={(o) => { if (!o) setLightboxIndex(null); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Popup
            aria-label={activeEntry?.kind === "video" ? "Video viewer" : "Image viewer"}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 outline-none data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 motion-reduce:animate-none"
            onClick={() => setLightboxIndex(null)}
          >
            <DialogPrimitive.Close aria-label="Close" className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20">
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
            {viewable.length > 1 && (
              <span className="absolute left-4 top-4 rounded-full bg-white/10 px-3 py-1 text-sm text-white">{(lightboxIndex ?? 0) + 1} / {viewable.length}</span>
            )}
            {viewable.length > 1 && (
              <button type="button" aria-label="Previous"
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => (i === null ? null : (i - 1 + viewable.length) % viewable.length)); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20">
                <ChevronLeft className="h-6 w-6" />
              </button>
            )}
            <div className="flex max-h-[90vh] max-w-[90vw] items-center justify-center" onClick={(e) => e.stopPropagation()}>
              {activeEntry?.kind === "video" ? (
                <video key={activeEntry.url} src={activeEntry.url} controls autoPlay className="max-h-[90vh] max-w-[90vw]"><track kind="captions" /></video>
              ) : activeEntry ? (
                <img src={activeEntry.url} alt="" className="max-h-[90vh] max-w-[90vw] object-contain" />
              ) : null}
            </div>
            {viewable.length > 1 && (
              <button type="button" aria-label="Next"
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => (i === null ? null : (i + 1) % viewable.length)); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20">
                <ChevronRight className="h-6 w-6" />
              </button>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
