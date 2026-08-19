// Parameterised attachment upload-queue hook for the Phase-2 Tasks + Tickets
// module (M7). Clones the XHR machinery of use-listing-media-upload.ts but the
// endpoints come in as props, so one hook serves all three attachment flows:
//
//   tasks:    mintPath /tasks/:id/attachments/upload-url    + completePath /tasks/:id/attachments/complete
//   tickets:  mintPath /tickets/:id/attachments/upload-url  + completePath /tickets/:id/attachments/complete
//   history:  mintPath /units/:unitId/history/attachments/upload-url + completePath null (mint-only —
//             the entry doesn't exist yet, so keys are collected via onUploaded and submitted with the form)
//
// NOTE: the tasks-module mint schema takes { filename, mimeType, sizeBytes } —
// there is NO `kind` field, unlike the listings media mint.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";

export type Phase2UploadItem = {
  id: string;
  file: File;
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

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const PDF_MIME = "application/pdf";

// Client-side caps mirroring the server's tasks-media gate (env-driven via
// runtimeConfig.limits, defaults match these): videos get the video cap;
// images and PDFs share the photo cap (a quote PDF has no business being
// 50 MB). Catching oversize early prevents the requesting → 400 round-trip
// and gives the user an immediate, specific toast they can act on.
const FILE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB — images + PDFs
const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50 MB — videos (Free-tier safe)

function capFor(file: File): number | null {
  const mime = file.type.toLowerCase();
  if (VIDEO_MIMES.has(mime)) return VIDEO_MAX_BYTES;
  if (IMAGE_MIMES.has(mime) || mime === PDF_MIME) return FILE_MAX_BYTES;
  return null;
}

export function usePhase2AttachmentUpload(opts: {
  /** Mint endpoint, e.g. `/tasks/${taskId}/attachments/upload-url`. */
  mintPath: string;
  /**
   * Complete endpoint, e.g. `/tasks/${taskId}/attachments/complete`.
   * null ⇒ mint-only flow (unit history): the server records nothing at
   * upload time, so callers collect keys via onUploaded and submit them
   * with the quick-log / resolve form body.
   */
  completePath: string | null;
  /** Fires after the storage PUT (and complete, when set) succeeds — once per file. */
  onUploaded: (storageKey: string) => void;
  /** Complete flows only: the server's canonical attachmentKeys array after each complete. */
  onCompleted?: (keys: string[]) => void;
}) {
  const [queue, setQueue] = useState<Phase2UploadItem[]>([]);
  const runningRef = useRef(false);

  // Cancellation epoch — reset() bumps it; runOne captures it at entry and
  // bails at every phase boundary when stale. xhr.abort() only covers the
  // uploading phase; the epoch is what stops an item awaiting the mint or
  // complete fetch from continuing and firing onUploaded/onCompleted after a
  // reset — in mint-only flows that would contaminate the caller's
  // collected-keys state for the NEXT submission.
  const epochRef = useRef(0);

  // Keep opts fresh inside the async runOne without stale-closure bugs.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

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

  const patchItem = useCallback((id: string, p: Partial<Phase2UploadItem>) => {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...p } : q)));
  }, []);

  const runOne = useCallback(
    async (item: Phase2UploadItem) => {
      const { mintPath, completePath } = optsRef.current;
      const epoch = epochRef.current;
      try {
        patchItem(item.id, { status: "requesting", progress: 0 });
        const signedRes = await apiFetch<{ data: SignedUploadUrl }>(mintPath, {
          method: "POST",
          // No `kind` field — the tasks mint schema derives it from mimeType.
          body: JSON.stringify({
            filename: item.file.name,
            mimeType: item.file.type,
            sizeBytes: item.file.size,
          }),
        });
        const signed = signedRes.data;

        // Mint resolved after a reset() — don't start the PUT.
        if (epoch !== epochRef.current || !mountedRef.current) return;

        patchItem(item.id, { status: "uploading", progress: 5, storageKey: signed.storageKey });

        // XHR for upload progress (fetch doesn't expose progress). The xhrRef
        // lets the cleanup effect abort mid-flight uploads when the component
        // unmounts — otherwise the bytes reach Supabase but /complete (or the
        // form submit carrying the key) never happens, leaving orphaned
        // storage objects.
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

        // Bail out if the component unmounted mid-upload — the abort handler
        // rejects the promise, but add a defence-in-depth guard in case the
        // upload finished just before unmount. The epoch check stops a PUT
        // that finished just before a reset() from being recorded — the
        // object stays orphaned in storage, which is the storage-lifecycle
        // concern, not a request-path one.
        if (!mountedRef.current || epoch !== epochRef.current) return;

        if (completePath) {
          patchItem(item.id, { status: "completing", progress: 100 });
          const completeRes = await apiFetch<{ data: { attachmentKeys: string[] } }>(
            completePath,
            {
              method: "POST",
              body: JSON.stringify({ storageKey: signed.storageKey }),
            },
          );
          // Stale complete (reset() fired while the POST was in flight) —
          // drop both callbacks so the cancelled key can't leak to the caller.
          if (!mountedRef.current || epoch !== epochRef.current) return;
          optsRef.current.onCompleted?.(completeRes.data.attachmentKeys);
        }
        optsRef.current.onUploaded(signed.storageKey);
        patchItem(item.id, { status: "done", progress: 100 });
      } catch (err) {
        patchItem(item.id, {
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
    [patchItem],
  );

  // Auto-drive: whenever queue gains a queued item and nothing's running, run the next.
  useEffect(() => {
    if (runningRef.current) return;
    const next = queue.find((q) => q.status === "queued");
    if (!next) return;
    runningRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setQueue runs in an async .finally (not sync in the effect body); it re-kicks this effect to drain items queued while runOne was in flight. Mirrors use-listing-media-upload.ts.
    runOne(next).finally(() => {
      runningRef.current = false;
      // Trigger a re-check in case more items queued during runOne.
      setQueue((prev) => [...prev]);
    });
  }, [queue, runOne]);

  const enqueue = useCallback((files: FileList | File[]) => {
    const items: Phase2UploadItem[] = [];
    const rejectedMime: string[] = [];
    const rejectedSize: string[] = [];
    for (const file of Array.from(files)) {
      const cap = capFor(file);
      if (cap === null) {
        rejectedMime.push(file.name);
        continue;
      }
      if (file.size > cap) {
        rejectedSize.push(file.name);
        continue;
      }
      items.push({
        id: crypto.randomUUID(),
        file,
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
      const fileMb = Math.floor(FILE_MAX_BYTES / 1024 / 1024);
      const videoMb = Math.floor(VIDEO_MAX_BYTES / 1024 / 1024);
      toast.error(
        rejectedSize.length === 1
          ? `File too large: ${rejectedSize[0]} (videos must be ≤ ${videoMb} MB, images/PDFs ≤ ${fileMb} MB)`
          : `Files too large: ${rejectedSize.join(", ")}`,
      );
    }
    setQueue((prev) => [...prev, ...items]);
    return {
      accepted: items.length,
      rejected: rejectedMime.length + rejectedSize.length,
    };
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

  // Abort any in-flight upload and drop the whole queue — for "dialog closed /
  // form submitted, start fresh". The epoch bump marks items stuck awaiting
  // the mint/complete fetch (which xhr.abort() can't reach) as stale so their
  // callbacks never fire; the error-patch from the abort handler no-ops
  // because the item is no longer in the queue.
  const reset = useCallback(() => {
    epochRef.current += 1;
    xhrRef.current?.abort();
    xhrRef.current = null;
    setQueue([]);
  }, []);

  const isUploading = queue.some(
    (q) =>
      q.status === "queued" ||
      q.status === "requesting" ||
      q.status === "uploading" ||
      q.status === "completing",
  );

  return { items: queue, enqueue, retry, reset, isUploading };
}
