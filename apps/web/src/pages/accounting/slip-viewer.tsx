// Inline viewer for tenant-uploaded transfer slips.
//
// The admin's whole job on the verification panel is to LOOK at the slip and
// decide whether the money arrived. It used to be a link that saved the file to
// disk: leave the drawer, hunt the download, open it, come back. The slip now
// renders in place, and clicking it opens a full-size lightbox — the same
// read-it-here treatment inventory photos get.
//
// WHY THE BYTES GO THROUGH A BLOB instead of straight into <img src={url}>:
// the signed URL keeps its download disposition (pending-payments.service.ts
// says why), and the content type Supabase serves is the TENANT'S to choose —
// they supply the bytes and the PUT header both. So the URL is fetched, never
// navigated to, and the bytes are re-wrapped in a Blob whose type WE set from
// the storage key's extension. The browser can then only ever treat a slip as
// the image or PDF it claims to be: markup posing as a .jpg is a broken image
// here, never a page.
import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Download, FileWarning, Maximize2, X } from "lucide-react";
import type { PendingPaymentSlip } from "@/api/payments";

type SlipLoad =
  | { status: "loading" }
  | { status: "ready"; objectUrl: string }
  | { status: "failed" };

/**
 * Fetches one slip and hands back a blob URL stamped with the server's
 * `mimeType`. Failure is a state, not a throw: a slip we can't preview still
 * has a download link beside it, and the admin still has the amount, the
 * reference and the lines to judge — the panel must never go blank over it.
 */
function useSlipBlobUrl(slip: PendingPaymentSlip): SlipLoad {
  const { url, mimeType } = slip;
  // Stamped with the URL it belongs to: a re-signed slip is different bytes, and
  // must read as loading again rather than keep showing the previous blob.
  // `objectUrl: null` is the failed outcome.
  const [loaded, setLoaded] = useState<{ forUrl: string; objectUrl: string | null } | null>(null);

  useEffect(() => {
    // No mimeType means the server couldn't place the file from its key — there
    // is nothing safe to stamp the bytes with, so don't fetch them at all.
    if (!mimeType) return;
    let cancelled = false;
    let created: string | null = null;

    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`slip fetch failed: ${res.status}`);
        const bytes = await res.blob();
        // Re-wrap with OUR type — this is the line that makes the preview safe.
        created = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        if (cancelled) return;
        setLoaded({ forUrl: url, objectUrl: created });
      } catch {
        if (!cancelled) setLoaded({ forUrl: url, objectUrl: null });
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url, mimeType]);

  if (!mimeType) return { status: "failed" };
  if (!loaded || loaded.forUrl !== url) return { status: "loading" };
  return loaded.objectUrl ? { status: "ready", objectUrl: loaded.objectUrl } : { status: "failed" };
}

function slipLabel(index: number, count: number): string {
  return count > 1 ? `Transfer slip ${index + 1} of ${count}` : "Transfer slip";
}

/** Download link — the slip's URL already carries an attachment disposition. */
function SaveACopy({ slip }: { slip: PendingPaymentSlip }) {
  return (
    <a
      href={slip.url}
      download={slip.filename}
      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
    >
      <Download className="h-3 w-3" />
      Save a copy
    </a>
  );
}

/**
 * One slip: a preview in the card, and a lightbox on click. Each tile owns its
 * own dialog because each owns its own blob URL — a shared lightbox would need
 * every slip's bytes resident whether or not the admin opened it.
 */
function SlipTile({
  slip,
  index,
  count,
}: {
  slip: PendingPaymentSlip;
  index: number;
  count: number;
}) {
  const load = useSlipBlobUrl(slip);
  const [zoomed, setZoomed] = useState(false);
  // An <img> that decodes fine everywhere else still fails on HEIC outside
  // Safari, and iPhones hand out HEIC by default. Treat that like any other
  // preview failure rather than leaving a broken-image glyph on a money screen.
  const [decodeFailed, setDecodeFailed] = useState(false);

  const label = slipLabel(index, count);
  const viewLabel = count > 1 ? `View slip ${index + 1}` : "View transfer slip";
  const unpreviewable = slip.kind === "other" || decodeFailed || load.status === "failed";

  // The fallback below is deliberate, but a slip the server said we COULD show
  // that then didn't should be visible to us, not quietly absorbed.
  useEffect(() => {
    if (import.meta.env.DEV && slip.kind !== "other" && unpreviewable) {
      console.warn(`[accounting] transfer slip preview unavailable (${slip.filename})`);
    }
  }, [slip.kind, slip.filename, unpreviewable]);

  return (
    <div className="min-w-[14rem] flex-1 space-y-1.5">
      <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
        {unpreviewable ? (
          <a
            href={slip.url}
            download={slip.filename}
            className="flex h-48 flex-col items-center justify-center gap-2 px-4 text-center transition hover:bg-background/60"
          >
            <FileWarning className="h-6 w-6 text-amber-600" />
            <span className="text-xs text-muted-foreground">
              This one can&apos;t be shown here — download it to check the slip.
            </span>
          </a>
        ) : load.status !== "ready" ? (
          <div role="status" aria-label={`Loading ${label}`} className="h-48 w-full animate-pulse bg-muted" />
        ) : slip.kind === "image" ? (
          <button
            type="button"
            aria-label={viewLabel}
            onClick={() => setZoomed(true)}
            className="group relative block h-48 w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <img
              src={load.objectUrl}
              alt={label}
              onError={() => setDecodeFailed(true)}
              className="h-48 w-full bg-black/[0.03] object-contain dark:bg-white/[0.03]"
            />
            <span className="absolute right-2 top-2 rounded-md bg-black/50 p-1.5 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2 className="h-3.5 w-3.5" />
            </span>
          </button>
        ) : (
          // <object>, not <iframe>: its children render as the browser's own
          // fallback when it can't display a PDF inline (Safari has been that
          // browser more than once), so a PDF slip degrades to a link instead
          // of to a white rectangle.
          <div className="relative">
            <object
              data={load.objectUrl}
              type="application/pdf"
              title={label}
              className="block h-64 w-full bg-white"
            >
              <a
                href={slip.url}
                download={slip.filename}
                className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground transition hover:bg-background/60"
              >
                <FileWarning className="h-6 w-6 text-amber-600" />
                This browser won&apos;t show the PDF — open it to check the slip.
              </a>
            </object>
            <button
              type="button"
              aria-label={viewLabel}
              onClick={() => setZoomed(true)}
              className="absolute right-2 top-2 rounded-md bg-black/50 p-1.5 text-white transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{label}</span>
        <SaveACopy slip={slip} />
      </div>

      {/* base-ui Dialog, not a hand-rolled portal: this panel lives inside the
          invoice Sheet, and the Sheet's focus management unmounts a bare portal
          out from under itself (see components/attachments-panel.tsx). */}
      <DialogPrimitive.Root open={zoomed} onOpenChange={setZoomed}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Popup
            aria-label={`${label} viewer`}
            onClick={() => setZoomed(false)}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 outline-none data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 motion-reduce:animate-none"
          >
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
            <div
              className="flex max-h-[90vh] max-w-[90vw] items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              {load.status !== "ready" ? null : slip.kind === "image" ? (
                <img src={load.objectUrl} alt={label} className="max-h-[90vh] max-w-[90vw] object-contain" />
              ) : (
                <object
                  data={load.objectUrl}
                  type="application/pdf"
                  title={`${label} full size`}
                  className="block h-[85vh] w-[90vw] bg-white"
                >
                  <a href={slip.url} download={slip.filename} className="text-sm text-white underline">
                    Open the PDF
                  </a>
                </object>
              )}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

/** Every slip on one pending payment, previewed side by side. */
export function SlipViewer({ slips }: { slips: PendingPaymentSlip[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {slips.map((slip, i) => (
        <SlipTile key={slip.url} slip={slip} index={i} count={slips.length} />
      ))}
    </div>
  );
}
