import { useCallback, useEffect, useRef, useState } from "react";
import { createPatchHistory, type Patch } from "./patch-history";
export const stagedKey = (period: string) => `bills-grid:staged:${period}`;
export type StagedEdits = Record<string, string>; // `${cellKey}:${columnId}` → raw cell text
function read(period: string): StagedEdits {
  try {
    const raw = sessionStorage.getItem(stagedKey(period));
    return raw == null ? {} : (JSON.parse(raw) as StagedEdits);
  } catch { return {}; }
}
export function useStagedEdits(period: string) {
  const [staged, setStaged] = useState<StagedEdits>(() => read(period));
  // `stagedRef` mirrors the latest buffer SYNCHRONOUSLY so `stage`/`unstage` can
  // read the true `prev` value (and sequential edits inside a `runBatch` see each
  // other) without a functional-updater side-effect. Every write goes through
  // `setBuffer`, which keeps ref + state + sessionStorage in lockstep.
  const stagedRef = useRef(staged);
  // Undo/redo history (patch-history.ts). Held in a ref (never re-created); the
  // reactive mirror `hist` below drives button enable state + counts.
  const historyRef = useRef(createPatchHistory<string>());
  // Batch state: while depth > 0, `stage`/`unstage` accumulate their patch into
  // `batchPatchesRef` instead of recording individually — so a Delete over N cells
  // records as ONE undo step (R6).
  const batchDepthRef = useRef(0);
  const batchPatchesRef = useRef<Patch[]>([]);
  const [hist, setHist] = useState({ canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 });

  const persist = useCallback((next: StagedEdits) => {
    try { sessionStorage.setItem(stagedKey(period), JSON.stringify(next)); }
    catch { /* private mode / quota — in-memory buffer stays authoritative */ }
  }, [period]);

  const setBuffer = useCallback((next: StagedEdits) => {
    stagedRef.current = next;
    setStaged(next);
    persist(next);
  }, [persist]);

  const syncHist = useCallback(() => {
    const h = historyRef.current;
    setHist({ canUndo: h.canUndo(), canRedo: h.canRedo(), undoDepth: h.undoDepth(), redoDepth: h.redoDepth() });
  }, []);

  // Period change: reload this period's buffer AND reset the history together, so a
  // stale patch can never apply against a different period's buffer (R8). Each
  // period has its own sessionStorage key. The setState calls here are an
  // intentional external→React sync on the `period` prop change (mirrors the
  // pre-history behavior), hence the targeted disables.
  useEffect(() => {
    const loaded = read(period);
    stagedRef.current = loaded;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional per-period buffer reload
    setStaged(loaded);
    historyRef.current.reset();
    syncHist(); // mirrors the (now-reset) history into reactive state
  }, [period, syncHist]);

  // Record one patch as a step — or defer it into the currently-open batch group.
  // Inside a batch, coalesce per key so a group NEVER holds two patches on the same
  // cell (keep the FIRST prev, take the LATEST next) — otherwise applyGroup's undo,
  // which sets each key once, would land on the intermediate value instead of the
  // pre-batch one for a cell written twice in the same batch.
  const emit = useCallback((patch: Patch, coalesceKey?: string) => {
    if (batchDepthRef.current > 0) {
      const existing = batchPatchesRef.current.find((p) => p.key === patch.key);
      if (existing) existing.next = patch.next;
      else batchPatchesRef.current.push(patch);
      return;
    }
    historyRef.current.record([patch], coalesceKey);
    syncHist();
  }, [syncHist]);

  const stage = useCallback((cellKey: string, columnId: string, value: string) => {
    const key = `${cellKey}:${columnId}`;
    const prevStaged = stagedRef.current;
    const prev = Object.prototype.hasOwnProperty.call(prevStaged, key) ? prevStaged[key] : undefined;
    if (prev === value) return; // no-op — no buffer write, no history step
    setBuffer({ ...prevStaged, [key]: value });
    emit({ key, prev, next: value }, key); // coalesce consecutive edits to the SAME cell (R5)
  }, [setBuffer, emit]);

  // Esc-revert / Delete-of-a-staged-cell: remove exactly ONE staged key. Deleting
  // a key that isn't present is a safe no-op. Reverts the PAGE buffer only;
  // GridTable's own internalStaged echo is cleared separately by revertActiveEdit.
  const unstage = useCallback((cellKey: string, columnId: string) => {
    const key = `${cellKey}:${columnId}`;
    const prevStaged = stagedRef.current;
    if (!Object.prototype.hasOwnProperty.call(prevStaged, key)) return; // no key, no-op, no history step
    const prev = prevStaged[key];
    const next = { ...prevStaged };
    delete next[key];
    setBuffer(next);
    emit({ key, prev, next: undefined }, key);
  }, [setBuffer, emit]);

  // Group every mutation emitted inside `fn` into ONE undo step (R6). Nested
  // stage/unstage read the synchronously-updated `stagedRef`, so they see each
  // other's writes; their patches accumulate and record as a single group on exit.
  const runBatch = useCallback((fn: () => void) => {
    batchDepthRef.current += 1;
    if (batchDepthRef.current === 1) batchPatchesRef.current = [];
    try {
      fn();
    } finally {
      batchDepthRef.current -= 1;
      if (batchDepthRef.current === 0 && batchPatchesRef.current.length > 0) {
        historyRef.current.record(batchPatchesRef.current, undefined); // grouped op — no coalesce
        batchPatchesRef.current = [];
        syncHist();
      }
    }
  }, [syncHist]);

  // Apply a history group to the buffer (undo → `prev`, redo → `next`) WITHOUT
  // re-recording, and return the affected keys so the caller can sync any display
  // echo. NEVER a server write.
  const applyGroup = useCallback((group: Patch[] | null, dir: "prev" | "next"): string[] => {
    if (!group) return [];
    const next = { ...stagedRef.current };
    for (const p of group) {
      const v = p[dir];
      if (v === undefined) delete next[p.key];
      else next[p.key] = v;
    }
    setBuffer(next);
    syncHist();
    return group.map((p) => p.key);
  }, [setBuffer, syncHist]);

  const undo = useCallback(() => applyGroup(historyRef.current.undo(), "prev"), [applyGroup]);
  const redo = useCallback(() => applyGroup(historyRef.current.redo(), "next"), [applyGroup]);

  const clear = useCallback(() => {
    stagedRef.current = {};
    setStaged({});
    try { sessionStorage.removeItem(stagedKey(period)); } catch { /* ignore */ }
    historyRef.current.reset();
    syncHist();
  }, [period, syncHist]);

  return {
    staged, stage, unstage, clear, dirtyCount: Object.keys(staged).length,
    undo, redo, runBatch,
    canUndo: hist.canUndo, canRedo: hist.canRedo, undoDepth: hist.undoDepth, redoDepth: hist.redoDepth,
  };
}
