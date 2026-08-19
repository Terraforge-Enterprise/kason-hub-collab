import { useCallback, useState } from "react";
import { loadPref, savePref } from "@/lib/view-prefs";
// R31(f)+R32: in-app maximize only (never requestFullscreen — R32 needs Escape
// to keep the grid open). The table zoom-scale control was removed (R3,
// 2026-07-12); only the full-viewport overlay remains. Name kept to avoid churn
// across importers.
export function useFullscreenZoom() {
  const [maximized, setMaximized] = useState(() => loadPref("bills-grid", "maximized", false));
  const toggleMaximized = useCallback(() => {
    setMaximized((on) => { savePref("bills-grid", "maximized", !on); return !on; });
  }, []);
  return { maximized, toggleMaximized };
}
