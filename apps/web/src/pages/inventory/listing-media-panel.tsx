import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Upload, Trash2, Download, Expand, X, ChevronLeft, ChevronRight } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useListingMediaUpload } from "@/hooks/use-listing-media-upload";
import { useMediaLimits } from "@/api/media-limits";
import { isEditableKeyTarget } from "@/lib/dom";

// Trigger threshold for the "compress before upload?" modal: half of the
// active video cap. Free-tier (50 MB cap) → modal at 25 MB; Pro (e.g.
// 500 MB cap) → modal at 250 MB. Always leaves the transcoded output
// comfortable slack under the hard cap enforced by the hook + server.

type Props = {
  photoKeys: string[];
  videoKeys: string[];
  listingId: string | null;
  onPhotoKeysChange: (next: string[]) => void;
  onVideoKeysChange: (next: string[]) => void;
};

type PhotoEntry = { key: string; url: string; thumbnail: string };
type VideoEntry = { key: string; url: string };
type BulkMediaResponse = { data: { photos: PhotoEntry[]; videos: VideoEntry[] } };

export function ListingMediaPanel({
  photoKeys,
  videoKeys,
  listingId,
  onPhotoKeysChange,
  onVideoKeysChange,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ key: string; kind: "photo" | "video" } | null>(null);
  const [removing, setRemoving] = useState(false);

  // Compression-prompt modal state. When the user picks (or drops) a
  // large video, we surface a Compress / Upload-as-is / Cancel choice
  // before enqueueing — the wasm bundle is ~30 MB so we never compress
  // without explicit consent.
  const [compressPrompt, setCompressPrompt] = useState<File | null>(null);
  const [compressProgress, setCompressProgress] = useState<number | null>(null);
  const queuedSmallFilesRef = useRef<File[]>([]);

  // Server-confirmed deletions made in this mount. The remove path now
  // hits DELETE /listings/:id/media and the server is the source of truth
  // for photoKeys/videoKeys, so any later refetch of the unit returns the
  // post-delete arrays — there is no client-only "pending delete" state
  // to defend against a refetch.
  //
  // The set is still useful as a CLIENT-SIDE guard against a concurrent
  // upload-complete that races our delete: complete() reads photoKeys
  // before our DELETE writes, returns the pre-delete merged list, and the
  // hook's onSuccess would otherwise bubble that resurrected list up to
  // the parent. Filtering through this set keeps the parent's view in
  // line with the user's intent until the next refetch reconciles.
  // Cleared on unmount (parent form save closes the dialog).
  const removedKeysRef = useRef<Set<string>>(new Set());

  const { data: limits } = useMediaLimits();
  const photoMaxBytes = limits?.photoMaxBytes ?? 15 * 1024 * 1024;
  const videoMaxBytes = limits?.videoMaxBytes ?? 50 * 1024 * 1024;
  // Modal trigger sits at half the active video cap. Compressed output
  // typically lands around 30-50% of source, so this threshold gives a
  // realistic chance of fitting under the hard cap after transcode.
  const compressTriggerBytes = Math.floor(videoMaxBytes / 2);

  const { queue, enqueue, clearDone, retry } = useListingMediaUpload({
    listingId: listingId ?? "",
    caps: { photoMaxBytes, videoMaxBytes },
    onSuccess: (updated) => {
      const removed = removedKeysRef.current;
      // The server returned the canonical DB state, including keys the
      // user has pending-deleted in this session. Strip them before
      // bubbling up so the parent form's pending-delete intent survives.
      onPhotoKeysChange(updated.photoKeys.filter((k) => !removed.has(k)));
      onVideoKeysChange(updated.videoKeys.filter((k) => !removed.has(k)));
    },
  });

  // Auto-clear finished rows after 3 s.
  useEffect(() => {
    if (!queue.some((q) => q.status === "done")) return;
    const t = setTimeout(() => clearDone(), 3000);
    return () => clearTimeout(t);
  }, [queue, clearDone]);

  // Intake gate: split incoming files into "small enough to upload
  // straight away" and "large videos that need a compression decision".
  // Only one prompt at a time — large videos beyond the first stay in
  // queuedSmallFilesRef and surface as the next prompt after the user
  // resolves the current one.
  const intake = useCallback(
    (incoming: FileList | File[]) => {
      const arr = Array.from(incoming);
      const small: File[] = [];
      const large: File[] = [];
      for (const f of arr) {
        const isVideo = f.type.startsWith("video/");
        if (isVideo && f.size > compressTriggerBytes) {
          large.push(f);
        } else {
          small.push(f);
        }
      }
      if (small.length > 0) enqueue(small);
      if (large.length > 0) {
        // Stash the rest; the modal handles `large[0]` and its
        // resolution path drains the queue.
        queuedSmallFilesRef.current = large.slice(1);
        setCompressPrompt(large[0]);
      }
    },
    [enqueue, compressTriggerBytes],
  );

  const advanceCompressionQueue = useCallback(() => {
    setCompressProgress(null);
    const next = queuedSmallFilesRef.current.shift();
    setCompressPrompt(next ?? null);
  }, []);

  const handleCompress = useCallback(async () => {
    const source = compressPrompt;
    if (!source) return;
    setCompressProgress(0);
    let mod: typeof import("@/lib/video-compress");
    try {
      mod = await import("@/lib/video-compress");
    } catch (err) {
      toast.error(
        "Compression library failed to load. Pick a smaller file or upload as-is.",
      );
      console.error("[video-compress] dynamic import failed", err);
      advanceCompressionQueue();
      return;
    }
    const result = await mod.compressVideoIfOversize(
      source,
      compressTriggerBytes,
      (frac) => setCompressProgress(Math.round(frac * 100)),
    );
    if ("skipped" in result) {
      // NEVER auto-fall-back to upload-original — the user explicitly
      // chose to compress. Surface the failure and let them try a
      // different file.
      toast.error(`Compression failed: ${result.reason}`);
      advanceCompressionQueue();
      return;
    }
    if (result.output.size > videoMaxBytes) {
      toast.error(
        `Compressed file still exceeds the ${Math.floor(videoMaxBytes / 1024 / 1024)} MB cap.`,
      );
      advanceCompressionQueue();
      return;
    }
    enqueue([result.output]);
    advanceCompressionQueue();
  }, [compressPrompt, enqueue, advanceCompressionQueue, compressTriggerBytes, videoMaxBytes]);

  const handleUploadAsIs = useCallback(() => {
    const source = compressPrompt;
    if (!source) return;
    if (source.size > videoMaxBytes) {
      toast.error(
        `${source.name} is ${Math.round(source.size / 1024 / 1024)} MB — over the ${Math.floor(videoMaxBytes / 1024 / 1024)} MB cap. Compress or pick another file.`,
      );
      advanceCompressionQueue();
      return;
    }
    enqueue([source]);
    advanceCompressionQueue();
  }, [compressPrompt, enqueue, advanceCompressionQueue, videoMaxBytes]);

  const handleCancelCompression = useCallback(() => {
    advanceCompressionQueue();
  }, [advanceCompressionQueue]);

  // Bulk-fetch signed URLs once (instead of N serial per-key calls).
  // Returns thumbnail URLs (server-side resize via Supabase Storage transform)
  // for the grid + full-size URLs for downloads.
  const [photoUrls, setPhotoUrls] = useState<Record<string, PhotoEntry>>({});
  const [videoUrls, setVideoUrls] = useState<Record<string, VideoEntry>>({});

  useEffect(() => {
    if (!listingId) return;
    if (photoKeys.length === 0 && videoKeys.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: resets the signed-URL cache when the listing's media keys change
      setPhotoUrls({});
      setVideoUrls({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch<BulkMediaResponse>(
          `/listings/${listingId}/media/download-urls`,
        );
        if (cancelled) return;
        const photoMap: Record<string, PhotoEntry> = {};
        for (const p of r.data.photos) photoMap[p.key] = p;
        setPhotoUrls(photoMap);
        const videoMap: Record<string, VideoEntry> = {};
        for (const v of r.data.videos) videoMap[v.key] = v;
        setVideoUrls(videoMap);
      } catch {
        // Tiles render empty; user can refresh.
      }
    })();
    return () => {
      cancelled = true;
    };
    // photoKeys/videoKeys are string[]; JSON.stringify gives a stable comparison
    // key (no nested objects with unstable ordering). Without this we'd either
    // refetch on every parent render (unstable array reference) or never
    // refetch on legitimate key changes — both wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId, JSON.stringify(photoKeys), JSON.stringify(videoKeys)]);

  if (!listingId) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] p-4 text-sm text-[var(--text-muted)]">
        Save this listing once to enable media uploads.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Upload drop zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload photos or videos"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          // Future-proof: drop-zone has no inputs today, but adding the
          // editable-target guard keeps the contract uniform with every
          // other role="button" wrapper in the app — see lib/dom.ts.
          if (isEditableKeyTarget(e)) return;
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
          if (e.dataTransfer.files.length > 0) intake(e.dataTransfer.files);
        }}
        className={`rounded-lg border-2 border-dashed p-8 text-center transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
          dragOver
            ? "border-[var(--gold)] bg-[var(--gold)]/5"
            : "border-[var(--card-border)] bg-[var(--card-bg)] hover:border-[var(--text-muted)]"
        }`}
      >
        <Upload className="h-8 w-8 mx-auto mb-2 text-[var(--text-muted)]" />
        <p className="text-sm font-medium text-[var(--text-primary)]">
          Drop photos or videos here, or click to browse
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          JPG / PNG / WebP up to {Math.floor(photoMaxBytes / 1024 / 1024)} MB · MP4 / MOV / WebM up to {Math.floor(videoMaxBytes / 1024 / 1024)} MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              intake(e.target.files);
            }
            // Always clear after handling — including rejection paths.
            // <input type="file"> retains its value until explicitly
            // cleared; without this, re-selecting the same file after a
            // rejection toast does NOT fire `change` (the browser thinks
            // nothing changed). Clearing via ref so it survives the
            // synthetic event being released back to React's pool.
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
      </div>

      {/* Queue */}
      {queue.length > 0 && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)]">
          <div className="px-4 py-2 border-b border-[var(--border)] text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Upload queue
          </div>
          <ul>
            {queue.map((q) => (
              <li key={q.id} className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm text-[var(--text-primary)]">{q.file.name}</p>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuenow={q.progress}
                    aria-valuemax={100}
                    aria-label={`Upload progress for ${q.file.name}`}
                    className="mt-1 h-1.5 rounded-full bg-[var(--border)] overflow-hidden"
                  >
                    <div
                      className={`h-full rounded-full transition-all ${
                        q.status === "error" ? "bg-rose-500" : q.status === "done" ? "bg-emerald-500" : "bg-[var(--gold)]"
                      }`}
                      style={{ width: `${q.progress}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {q.status === "queued" && "Waiting…"}
                    {q.status === "requesting" && "Requesting upload URL…"}
                    {q.status === "uploading" && `Uploading ${q.progress}%`}
                    {q.status === "completing" && "Finalising…"}
                    {q.status === "done" && "Done."}
                    {q.status === "error" && (q.error ?? "Upload failed.")}
                  </p>
                </div>
                {q.status === "error" && (
                  <Button type="button" variant="outline" size="xs" onClick={() => retry(q.id)}>
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Photos grid */}
      <MediaGrid
        label="Photos"
        keys={photoKeys}
        kind="photo"
        urls={photoUrls}
        onRemove={(key) => setConfirmRemove({ key, kind: "photo" })}
      />

      {/* Videos grid */}
      <MediaGrid
        label="Videos"
        keys={videoKeys}
        kind="video"
        urls={videoUrls}
        onRemove={(key) => setConfirmRemove({ key, kind: "video" })}
      />

      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(o) => {
          // Don't allow dismiss while the DELETE is in flight; otherwise
          // the user could close mid-request and the success bubble would
          // race a closed dialog state.
          if (!o && !removing) setConfirmRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmRemove?.kind}?</AlertDialogTitle>
            <AlertDialogDescription>
              The file will be permanently deleted from storage and removed from
              this listing. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmRemove(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={async () => {
                if (!confirmRemove || removing) return;
                setRemoving(true);
                try {
                  const r = await apiFetch<{
                    data: { photoKeys: string[]; videoKeys: string[] };
                  }>(
                    `/listings/${listingId}/media?key=${encodeURIComponent(confirmRemove.key)}`,
                    { method: "DELETE" },
                  );
                  // Server is now the source of truth — bubble its
                  // arrays up so the parent cache reflects post-delete
                  // state. Subsequent refetches return the same arrays;
                  // no resurrection.
                  removedKeysRef.current.add(confirmRemove.key);
                  onPhotoKeysChange(r.data.photoKeys);
                  onVideoKeysChange(r.data.videoKeys);
                  setConfirmRemove(null);
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Failed to remove file.",
                  );
                } finally {
                  setRemoving(false);
                }
              }}
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Compress-or-upload-as-is prompt for large videos. The wasm
          bundle is ~30 MB and only loads when the user picks the
          Compress button — no eager fetch on file selection. */}
      <AlertDialog
        open={compressPrompt !== null}
        onOpenChange={(o) => {
          if (!o && compressProgress === null) handleCancelCompression();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compress this video?</AlertDialogTitle>
            <AlertDialogDescription>
              {compressPrompt ? (
                <>
                  <strong>{compressPrompt.name}</strong> is{" "}
                  {Math.round(compressPrompt.size / 1024 / 1024)} MB. Compressing
                  re-encodes it to ~6 Mbps H.264 in your browser, which can
                  take a few minutes for long clips. You can also upload as-is
                  if it&apos;s under {Math.floor(videoMaxBytes / 1024 / 1024)} MB.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {compressProgress !== null && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuenow={compressProgress}
              aria-valuemax={100}
              aria-label="Compression progress"
              className="mt-2 h-2 rounded-full bg-[var(--border)] overflow-hidden"
            >
              <div
                className="h-full bg-[var(--gold)] transition-all"
                style={{ width: `${compressProgress}%` }}
              />
            </div>
          )}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancelCompression}
              disabled={compressProgress !== null}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleUploadAsIs}
              disabled={compressProgress !== null}
            >
              Upload as-is
            </Button>
            <Button
              type="button"
              onClick={handleCompress}
              disabled={compressProgress !== null}
            >
              {compressProgress !== null ? "Compressing…" : "Compress & upload"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MediaGrid({
  label,
  keys,
  kind,
  urls,
  onRemove,
}: {
  label: string;
  keys: string[];
  kind: "photo" | "video";
  urls: Record<string, PhotoEntry> | Record<string, VideoEntry>;
  onRemove: (key: string) => void;
}) {
  // Lightbox state: index into `keys` or null (closed).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Keyboard shortcuts while lightbox is open: Esc closes; arrows navigate
  // (photos only — videos have their own controls and keyboard arrows scrub).
  useEffect(() => {
    if (lightboxIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setLightboxIndex(null);
      } else if (kind === "photo" && e.key === "ArrowLeft") {
        setLightboxIndex((i) => (i === null ? null : (i - 1 + keys.length) % keys.length));
      } else if (kind === "photo" && e.key === "ArrowRight") {
        setLightboxIndex((i) => (i === null ? null : (i + 1) % keys.length));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, keys.length, kind]);

  // Lock body scroll while lightbox is open so the background doesn't move.
  useEffect(() => {
    if (lightboxIndex === null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [lightboxIndex]);

  if (keys.length === 0) return null;

  const activeKey = lightboxIndex !== null ? keys[lightboxIndex] : null;
  const activeEntry = activeKey ? urls[activeKey] : null;
  const activeFullUrl = activeEntry?.url;

  return (
    <>
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
          {label} ({keys.length})
        </h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
          {keys.map((key, index) => {
            const entry = urls[key];
            // For photos, prefer the resized thumbnail (~25 KB) for the grid.
            // For videos, the full URL is what we have — preload="none" so the
            // browser doesn't fetch bytes until the user actually plays.
            const tileSrc =
              entry && "thumbnail" in entry ? entry.thumbnail : entry?.url;
            const downloadUrl = entry?.url;
            const openLightbox = () => {
              if (entry) setLightboxIndex(index);
            };
            return (
              <div
                key={key}
                role="button"
                tabIndex={entry ? 0 : -1}
                aria-label={
                  kind === "photo"
                    ? `View photo ${index + 1} of ${keys.length}`
                    : `Play video ${index + 1} of ${keys.length}`
                }
                onClick={openLightbox}
                onKeyDown={(e) => {
                  // Future-proof: tile has no inputs today, but adding the
                  // editable-target guard keeps the contract uniform with
                  // every other role="button" wrapper — see lib/dom.ts.
                  if (isEditableKeyTarget(e)) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openLightbox();
                  }
                }}
                className="group relative aspect-square rounded-md overflow-hidden border border-[var(--border)] bg-muted/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {tileSrc ? (
                  kind === "photo" ? (
                    <img
                      src={tileSrc}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <video
                      src={tileSrc}
                      muted
                      preload="none"
                      className="h-full w-full object-cover"
                    />
                  )
                ) : (
                  <div className="h-full w-full animate-pulse bg-muted/60" />
                )}

                {/* Play-badge overlay for videos (always visible, not just on hover). */}
                {kind === "video" && tileSrc && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="h-10 w-10 rounded-full bg-black/50 flex items-center justify-center">
                      <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                  </div>
                )}

                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  {entry && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openLightbox();
                      }}
                      className="p-2 rounded-md bg-white/20 hover:bg-white/30 text-white"
                      aria-label={kind === "photo" ? "View full size" : "Play video"}
                    >
                      <Expand className="h-4 w-4" />
                    </button>
                  )}
                  {downloadUrl && (
                    <a
                      href={downloadUrl}
                      download
                      onClick={(e) => e.stopPropagation()}
                      className="p-2 rounded-md bg-white/20 hover:bg-white/30 text-white"
                      aria-label="Download"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  )}
                  {/* editor+ may delete listing media (photos & videos). The
                      DELETE /listings/:id/media route enforces the same
                      editor floor server-side; this gate only hides the UI. */}
                  <RoleGate min="editor">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(key);
                      }}
                      className="p-2 rounded-md bg-white/20 hover:bg-rose-500/70 text-white"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </RoleGate>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Lightbox overlay — portaled to <body> so it escapes the containing
          block + stacking context of any transformed / backdrop-filtered
          ancestor (e.g. the Update-unit DialogContent, which is both
          -translate-x/y-1/2 AND backdrop-blur-xl). Rendered inline, a
          `position: fixed` overlay is re-based to that ancestor's box and
          gets pinned inside the modal instead of covering the viewport.
          z-[60] sits above the z-50 modal. Same fix as bill-lightbox.tsx. */}
      {lightboxIndex !== null && activeFullUrl && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={kind === "photo" ? "Photo viewer" : "Video player"}
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxIndex(null)}
        >
          {/* Close */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxIndex(null);
            }}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Counter + download */}
          <div className="absolute top-4 left-4 flex items-center gap-2 text-white text-sm">
            <span className="px-3 py-1 rounded-full bg-white/10">
              {lightboxIndex + 1} / {keys.length}
            </span>
            <a
              href={activeFullUrl}
              download
              onClick={(e) => e.stopPropagation()}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition"
              aria-label="Download"
            >
              <Download className="h-4 w-4" />
            </a>
          </div>

          {/* Prev (photos only — videos have their own scrubber) */}
          {kind === "photo" && keys.length > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex((i) => (i === null ? null : (i - 1 + keys.length) % keys.length));
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
              aria-label="Previous"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}

          {/* Content */}
          <div
            className="max-w-[90vw] max-h-[90vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {kind === "photo" ? (
              <img
                key={activeFullUrl}
                src={activeFullUrl}
                alt={`Photo ${lightboxIndex + 1}`}
                className="max-w-[90vw] max-h-[90vh] object-contain"
              />
            ) : (
              <video
                key={activeFullUrl}
                src={activeFullUrl}
                controls
                autoPlay
                className="max-w-[90vw] max-h-[90vh]"
              >
                <track kind="captions" label={`Video ${lightboxIndex + 1}`} />
              </video>
            )}
          </div>

          {/* Next (photos only) */}
          {kind === "photo" && keys.length > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex((i) => (i === null ? null : (i + 1) % keys.length));
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
              aria-label="Next"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
