import { Component, type ReactNode, useEffect } from "react";

// One-shot guard (per tab) so a genuinely-missing chunk can't cause a reload loop.
const RELOAD_FLAG = "kason-chunk-reload";

/**
 * True for the browser errors thrown when a lazy `import()`'s chunk can't be fetched —
 * e.g. after a deploy replaced/removed the chunk the running app still references, or a
 * chunk is missing from the CDN (CloudFront then serves index.html, so the module load
 * rejects on a MIME mismatch). Kept broad across engines.
 */
function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|dynamically imported module/i.test(
    msg,
  );
}

/**
 * Clears the one-shot reload guard once a lazy route chunk has actually mounted —
 * proving the chunk loaded for this route, so a LATER chunk failure may reload again.
 * Rendered inside the Suspense boundary so it only mounts after the chunk resolves.
 */
export function ChunkLoadMarker(): null {
  useEffect(() => {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      /* sessionStorage may be unavailable (private mode) — safe to ignore */
    }
  }, []);
  return null;
}

/**
 * Catches lazy-import chunk-load failures so a stale/incomplete deploy degrades to a
 * one-shot auto-reload (re-fetching index.html + the current chunk map) instead of
 * unmounting the whole React tree into a blank white screen. If the reload doesn't fix
 * it (chunk genuinely absent), shows a graceful fallback with a manual Reload — scoped
 * inside the app layout so the sidebar/nav stay intact.
 */
export class ChunkErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (!isChunkLoadError(error)) return;
    let alreadyReloaded = false;
    try {
      alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === "1";
    } catch {
      /* ignore */
    }
    if (!alreadyReloaded) {
      try {
        sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        /* ignore */
      }
      window.location.reload();
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            This page failed to load. The app may have just updated — reloading usually
            fixes it.
          </p>
          <button
            type="button"
            onClick={() => {
              try {
                sessionStorage.removeItem(RELOAD_FLAG);
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
            className="rounded-md bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-white shadow transition hover:opacity-90"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
