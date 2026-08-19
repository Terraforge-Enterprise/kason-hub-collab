import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";

type UploadKind = "photo" | "video";

export type QueueItem = {
  id: string;
  file: File;
  kind: UploadKind;
  status: "queued" | "requesting" | "uploading" | "completing" | "done" | "error";
  progress: number; // 0-100
  storageKey?: string;
  error?: string;
};

type SignedUploadUrl = {
  uploadUrl: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
  storageKey: string;
};

const PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

// Client-side default caps. Free-tier-safe (Supabase Free buckets cap at
// 50 MB per file). The actual caps are env-driven server-side and exposed
// via GET /api/listings/media/limits — pages should read from there. These
// constants stay as a fallback when the hook caller doesn't pass `caps`.
// Catching oversize early prevents the requesting → 400 round-trip and
// gives the user an immediate, specific toast they can act on.
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50 MB (Free-tier safe)

function kindFor(file: File): UploadKind | null {
  const mime = file.type.toLowerCase();
  if (PHOTO_MIMES.has(mime)) return "photo";
  if (VIDEO_MIMES.has(mime)) return "video";
  return null;
}

export function useListingMediaUpload(opts: {
  listingId: string;
  onSuccess: (updated: { photoKeys: string[]; videoKeys: string[] }) => void;
  /**
   * Per-environment caps. When omitted, falls back to PHOTO_MAX_BYTES /
   * VIDEO_MAX_BYTES exported above (50 MB / 15 MB Free-tier-safe defaults).
   * Pages should fetch real caps from GET /api/listings/media/limits and
   * pass them through so the UI guard matches the server gate exactly.
   */
  caps?: { photoMaxBytes: number; videoMaxBytes: number };
}) {
  const photoMaxBytes = opts.caps?.photoMaxBytes ?? PHOTO_MAX_BYTES;
  const videoMaxBytes = opts.caps?.videoMaxBytes ?? VIDEO_MAX_BYTES;
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const runningRef = useRef(false);

  // Keep opts fresh inside the async runOne without stale-closure bugs.
  const listingIdRef = useRef(opts.listingId);
  const onSuccessRef = useRef(opts.onSuccess);
  useEffect(() => {
    listingIdRef.current = opts.listingId;
    onSuccessRef.current = opts.onSuccess;
  }, [opts.listingId, opts.onSuccess]);

  // Track mount state and any in-flight XHR so the cleanup effect can abort
  // mid-flight uploads when the component unmounts.
  const mountedRef = useRef(true);
  // Single-slot XHR handle for abort-on-unmount. Assumes the queue runs
  // serially (enforced by runningRef). If this hook is ever parallelised,
  // replace with a Set<XMLHttpRequest> so all in-flight requests are aborted.
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      xhrRef.current?.abort();
      xhrRef.current = null;
    };
  }, []);

  const patchItem = useCallback((id: string, p: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...p } : q)));
  }, []);

  const runOne = useCallback(async (item: QueueItem) => {
    const listingId = listingIdRef.current;
    try {
      patchItem(item.id, { status: "requesting", progress: 0 });
      const signedRes = await apiFetch<{ data: SignedUploadUrl }>(
        `/listings/${listingId}/media/upload-url`,
        {
          method: "POST",
          body: JSON.stringify({
            kind: item.kind,
            filename: item.file.name,
            mimeType: item.file.type,
            sizeBytes: item.file.size,
          }),
        },
      );
      const signed = signedRes.data;

      patchItem(item.id, { status: "uploading", progress: 5, storageKey: signed.storageKey });

      // XHR for upload progress (fetch doesn't expose progress). The xhrRef
      // lets the cleanup effect abort mid-flight uploads when the component
      // unmounts — otherwise the bytes reach Supabase but /complete is never
      // called, leaving orphaned storage objects.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open(signed.method, signed.uploadUrl);
        for (const [k, v] of Object.entries(signed.headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          patchItem(item.id, { progress: Math.round((e.loaded / e.total) * 95) + 5 });
        };
        xhr.onload = () => {
          xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(
              new Error(
                xhr.status === 401 || xhr.status === 403
                  ? "Upload failed — signed URL expired, please retry"
                  : `Upload failed (${xhr.status})`,
              ),
            );
          }
        };
        xhr.onerror = () => {
          xhrRef.current = null;
          reject(new Error("Network error during upload"));
        };
        xhr.onabort = () => {
          xhrRef.current = null;
          reject(new Error("Upload cancelled"));
        };
        xhr.send(item.file);
      });

      // The bytes are now in storage — /complete is the orphan-prevention
      // step that attaches them to the listing in the DB. It MUST fire even
      // if the component unmounted between onload and here (edit-shell tab
      // switch, dialog close): skipping it would leave a storage object the
      // DB never learns about (orphaned storage + a silently lost upload).
      // Only guard the setState calls that follow — patchItem() and the
      // onSuccess callback — since those touch a component that may be gone.
      if (mountedRef.current) {
        patchItem(item.id, { status: "completing", progress: 100 });
      }
      const completeRes = await apiFetch<{ data: { photoKeys: string[]; videoKeys: string[] } }>(
        `/listings/${listingId}/media/complete`,
        {
          method: "POST",
          body: JSON.stringify({ storageKey: signed.storageKey }),
        },
      );
      if (!mountedRef.current) return;
      onSuccessRef.current(completeRes.data);
      patchItem(item.id, { status: "done" });
    } catch (err) {
      patchItem(item.id, {
        status: "error",
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }, [patchItem]);

  // Auto-drive: whenever queue gains a queued item and nothing's running, run the next.
  useEffect(() => {
    if (runningRef.current) return;
    const next = queue.find((q) => q.status === "queued");
    if (!next) return;
    runningRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: serial upload-queue pump — the effect starts the next queued item and re-triggers itself when one finishes
    runOne(next).finally(() => {
      runningRef.current = false;
      // Trigger a re-check in case more items queued during runOne.
      setQueue((prev) => [...prev]);
    });
  }, [queue, runOne]);

  const enqueue = useCallback((files: FileList | File[]) => {
    const items: QueueItem[] = [];
    const rejectedMime: string[] = [];
    const rejectedSize: string[] = [];
    for (const file of Array.from(files)) {
      const kind = kindFor(file);
      if (!kind) {
        rejectedMime.push(file.name);
        continue;
      }
      const cap = kind === "photo" ? photoMaxBytes : videoMaxBytes;
      if (file.size > cap) {
        rejectedSize.push(file.name);
        continue;
      }
      items.push({
        id: crypto.randomUUID(),
        file,
        kind,
        status: "queued",
        progress: 0,
      });
    }
    if (rejectedMime.length > 0) {
      toast.error(
        rejectedMime.length === 1
          ? `Unsupported file type: ${rejectedMime[0]}`
          : `Unsupported file types: ${rejectedMime.join(", ")}`,
      );
    }
    if (rejectedSize.length > 0) {
      const photoMb = Math.floor(photoMaxBytes / 1024 / 1024);
      const videoMb = Math.floor(videoMaxBytes / 1024 / 1024);
      toast.error(
        rejectedSize.length === 1
          ? `File too large: ${rejectedSize[0]} (videos must be ≤ ${videoMb} MB, photos ≤ ${photoMb} MB)`
          : `Files too large: ${rejectedSize.join(", ")}`,
      );
    }
    setQueue((prev) => [...prev, ...items]);
    return {
      accepted: items.length,
      rejected: rejectedMime.length + rejectedSize.length,
    };
  }, [photoMaxBytes, videoMaxBytes]);

  const clearDone = useCallback(() => {
    setQueue((prev) => prev.filter((q) => q.status !== "done"));
  }, []);

  const retry = useCallback((id: string) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.id === id && q.status === "error"
          ? { ...q, status: "queued", error: undefined, progress: 0 }
          : q,
      ),
    );
  }, []);

  return { queue, enqueue, clearDone, retry };
}
