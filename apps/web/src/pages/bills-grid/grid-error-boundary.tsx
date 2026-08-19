import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Grid-scoped error boundary — NESTED inside the app-wide `ChunkErrorBoundary`.
 * React routes a thrown error to the NEAREST boundary, so this one catches
 * render crashes inside the bills grid before they ever reach the outer net.
 *
 * Pattern copied from `components/chunk-error-boundary.tsx`
 * (getDerivedStateFromError + a try/catch shell) — but deliberately NOT the
 * same component: this one never calls `window.location.reload()` and never
 * touches sessionStorage. Under D5 (no auto-save) the staged-edit buffer in
 * sessionStorage is the ONLY copy of unsaved work, so the crash-recovery path
 * must not destroy it — "Reload grid" remounts via `onReload` (the page
 * refetches/remounts) instead of a full page reload.
 */
export class GridErrorBoundary extends Component<
  { children: ReactNode; onReload: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            The bills grid hit an error while rendering. Your unsaved edits are still saved
            in this tab — reload the grid to try again.
          </p>
          <Button
            type="button"
            variant="gold"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onReload();
            }}
          >
            Reload grid
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
