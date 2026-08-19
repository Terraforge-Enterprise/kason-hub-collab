// BillLightbox — the in-page bill/receipt preview, extracted from ReceiptUploader's
// in-page lightbox (commit fe329ae5) so the per-expense proof view (Section 5) and
// the proof-pack panel (C2) share ONE viewer instead of duplicating it.
//
// A base-ui Dialog portaled to <body>: the viewer is rendered inside
// `backdrop-blur-xl` cards / drawers, and a CSS backdrop-filter ancestor establishes
// a containing block for `position: fixed`, which would otherwise pin an inline
// overlay inside that card instead of the viewport. Portaling out guarantees a true
// viewport-centered preview, and gives focus-trap + scroll-lock + correct nested
// Esc ordering for free. Images render in an <img>; PDFs (and any non-image) in an
// <iframe> — an <img> can't paint a PDF (which is what made it look "blank").
//
// Pure + presentational: it owns no data fetching. The caller passes the active
// slide (url/label/isImage) + open/index/total + the close/prev/next callbacks.
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";

/** Image filenames/keys get an inline <img>; everything else (PDF) an <iframe>. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
export function isImageFilename(name: string): boolean {
  return IMAGE_EXT_RE.test(name);
}

export function BillLightbox({
  open,
  index,
  total,
  url,
  label,
  isImage,
  onClose,
  onPrev,
  onNext,
}: {
  open: boolean;
  index: number | null;
  total: number;
  url: string | undefined;
  label: string;
  isImage: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          data-testid="bill-lightbox"
          aria-label={`Bill preview${label ? `: ${label}` : ""}`}
          // Backdrop click (anywhere outside the inner media) closes — the media
          // wrapper + controls stopPropagation so only the dimmed area dismisses.
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            Bill preview{label ? `: ${label}` : ""}
          </DialogPrimitive.Title>

          {/* Close */}
          <button
            type="button"
            aria-label="Close preview"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Counter + open-in-new-tab escape hatch */}
          <div className="absolute left-4 top-4 flex items-center gap-2 text-sm text-white">
            <span className="rounded-full bg-white/10 px-3 py-1">
              {(index ?? 0) + 1} / {total}
            </span>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open in new tab
              </a>
            )}
          </div>

          {/* Prev */}
          {total > 1 && (
            <button
              type="button"
              aria-label="Previous bill"
              onClick={(e) => {
                e.stopPropagation();
                onPrev();
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}

          {/* Media — images contained, PDFs in an iframe (an <img> can't show a PDF). */}
          <div
            className="flex max-h-[90vh] max-w-[90vw] items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {url &&
              (isImage ? (
                <img
                  key={url}
                  src={url}
                  alt={label}
                  className="max-h-[90vh] max-w-[90vw] object-contain"
                />
              ) : (
                <iframe
                  key={url}
                  src={url}
                  title={label}
                  className="h-[90vh] w-[90vw] rounded bg-white"
                />
              ))}
          </div>

          {/* Next */}
          {total > 1 && (
            <button
              type="button"
              aria-label="Next bill"
              onClick={(e) => {
                e.stopPropagation();
                onNext();
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          {/* Filename caption */}
          <div
            className="absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-white/10 px-3 py-1 text-sm text-white"
            title={label}
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
