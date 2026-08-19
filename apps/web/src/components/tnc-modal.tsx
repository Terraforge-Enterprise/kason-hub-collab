import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { TERMS_AND_CONDITIONS } from "@/lib/reservation-terms";

export function TncModal({
  open,
  onClose,
  onReadToBottom,
  customTerms,
  initialReachedBottom = false,
}: {
  open: boolean;
  onClose: () => void;
  onReadToBottom: () => void;
  /** Per-reservation list. Empty/undefined = render bundled defaults. */
  customTerms?: string[];
  initialReachedBottom?: boolean;
}) {
  const finalClauses = customTerms && customTerms.length > 0 ? customTerms : TERMS_AND_CONDITIONS;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [reachedBottom, setReachedBottom] = useState(initialReachedBottom);

  // If content fits without scrolling, no scroll event ever fires — user is
  // already "at the bottom". Mark read on open in that case. The
  // `scrollHeight > 0` guard skips jsdom's pre-layout zero-dimension state
  // (tests rely on the disabled button being visible on initial render).
  useEffect(() => {
    if (!open || reachedBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight > 0 && el.scrollHeight <= el.clientHeight + 4) {
      setReachedBottom(true);
      onReadToBottom();
    }
  }, [open, reachedBottom, onReadToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // 4px slack handles sub-pixel rounding (DPI scaling, browser zoom).
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4 && !reachedBottom) {
      setReachedBottom(true);
      onReadToBottom();
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tnc-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-border/60 bg-background shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-start justify-between p-6 pb-3">
          <h3 id="tnc-modal-title" className="text-lg font-semibold">
            Terms & Conditions
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="overflow-y-auto px-6 pb-4 text-sm space-y-2 flex-1"
        >
          <ol className="list-decimal pl-5 space-y-2">
            {finalClauses.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground italic mt-4 pb-2">
            (Scroll to the bottom to enable the agreement checkbox.)
          </p>
        </div>
        <div className="border-t border-border/40 px-6 py-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={!reachedBottom}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {reachedBottom ? "Close" : "Scroll to bottom to continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
