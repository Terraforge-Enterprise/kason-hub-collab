import { WifiOff, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LoadFailedProps {
  /** What failed to load, woven into the default heading, e.g. "your dashboard". */
  resource?: string;
  /** Override the default heading entirely. */
  title?: string;
  /** Override the default reassurance/body copy. */
  description?: string;
  /** Called when the user taps "Try again". Pass react-query's `refetch`. */
  onRetry: () => void;
  /** True while a retry is in flight — disables the button and shows a spinner. */
  retrying?: boolean;
  /** Compact inline variant for use inside an existing card/section. */
  compact?: boolean;
  className?: string;
}

/**
 * LoadFailed — the on-brand replacement for `<div>Failed to load X</div>`.
 *
 * Shows a calm, recoverable error state with a Retry button instead of a
 * dead-end message. Copy is framed around the common cause (the API container
 * re-warming its DB pool after idle) so a transient cold-start reads as "try
 * again in a moment", not "the app is broken".
 *
 * a11y: `role="alert"` announces the failure; the button is the recovery path.
 * Pair with a query whose `retry` rides out cold starts (see main.tsx) so this
 * only ever surfaces on a genuine, sustained failure.
 */
export function LoadFailed({
  resource,
  title,
  description,
  onRetry,
  retrying = false,
  compact = false,
  className,
}: LoadFailedProps) {
  const heading = title ?? `We couldn't load ${resource ?? "this page"}`;
  const body =
    description ??
    "The server may be waking up after a period of inactivity — this usually clears in a few seconds. Please try again.";

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-3 py-8" : "gap-4 py-16",
        className,
      )}
    >
      <div className={cn("rounded-2xl bg-amber-500/10", compact ? "p-3" : "p-4")}>
        <WifiOff className={cn("text-amber-600", compact ? "h-6 w-6" : "h-8 w-8")} />
      </div>
      <div className="max-w-md space-y-1.5">
        <h2 className={cn("font-bold text-foreground", compact ? "text-base" : "text-xl")}>
          {heading}
        </h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <Button variant="gold" onClick={onRetry} disabled={retrying} className="mt-1">
        {retrying ? (
          <>
            <Loader2 className="animate-spin" />
            Retrying…
          </>
        ) : (
          <>
            <RefreshCw />
            Try again
          </>
        )}
      </Button>
    </div>
  );
}
