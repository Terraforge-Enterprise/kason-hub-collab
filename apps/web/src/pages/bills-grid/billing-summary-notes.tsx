import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import type { GridRow } from "@/api/bills-grid";
import { fetchBillingSummaryNotes, saveBillingSummaryNote } from "@/api/bills-grid";
import { cn } from "@/lib/utils";

type SaveState = "idle" | "saving" | "saved" | "error";

export function BillingSummaryNotes({ rows, period }: { rows: GridRow[]; period: string }) {
  const query = useQuery({
    queryKey: ["bills-grid", "summary-notes", period],
    queryFn: () => fetchBillingSummaryNotes(period),
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const editedIds = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());

  useEffect(() => {
    if (!query.data) return;
    setNotes((current) => {
      const next = { ...current };
      for (const item of query.data) if (!editedIds.current.has(item.apartmentId)) next[item.apartmentId] = item.note;
      return next;
    });
  }, [query.data]);

  useEffect(() => () => { Object.values(timers.current).forEach(clearTimeout); }, []);
  useEffect(() => { if (editingId) inputRef.current?.focus(); }, [editingId]);
  useEffect(() => { if (selectedId && !editingId) cellRefs.current.get(selectedId)?.focus(); }, [selectedId, editingId]);

  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.apartmentId, index])), [rows]);

  async function persist(apartmentId: string, value: string) {
    clearTimeout(timers.current[apartmentId]);
    setSaveStates((state) => ({ ...state, [apartmentId]: "saving" }));
    try {
      await saveBillingSummaryNote(apartmentId, period, value);
      setSaveStates((state) => ({ ...state, [apartmentId]: "saved" }));
    } catch {
      setSaveStates((state) => ({ ...state, [apartmentId]: "error" }));
    }
  }

  function change(apartmentId: string, value: string) {
    editedIds.current.add(apartmentId);
    setNotes((state) => ({ ...state, [apartmentId]: value }));
    setSaveStates((state) => ({ ...state, [apartmentId]: "saving" }));
    clearTimeout(timers.current[apartmentId]);
    timers.current[apartmentId] = setTimeout(() => { void persist(apartmentId, value); }, 650);
  }

  function move(fromId: string, delta: number) {
    const current = rowIndex.get(fromId) ?? 0;
    const target = rows[Math.max(0, Math.min(rows.length - 1, current + delta))];
    if (target) setSelectedId(target.apartmentId);
  }

  async function selectedKeyDown(event: React.KeyboardEvent<HTMLTableCellElement>, row: GridRow) {
    if (editingId === row.apartmentId) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      await navigator.clipboard.writeText(notes[row.apartmentId] ?? "");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      const value = (await navigator.clipboard.readText()).slice(0, 500);
      change(row.apartmentId, value);
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault(); setEditingId(row.apartmentId); return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault(); change(row.apartmentId, ""); return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); move(row.apartmentId, 1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(row.apartmentId, -1); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      change(row.apartmentId, event.key);
      setEditingId(row.apartmentId);
    }
  }

  if (query.isLoading) return <div className="flex min-h-48 items-center justify-center gap-2 rounded-xl border bg-white text-lg text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading summaries…</div>;

  return (
    <div className="overflow-auto rounded-xl border-2 border-[var(--navy)] bg-white shadow-sm" data-testid="billing-summary-notes">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--page-bg)] px-4 py-3 text-sm text-muted-foreground">
        <span>Write one short note for each filtered unit. Changes save automatically.</span>
        <span>Click to select · Type / Enter / double-click to edit · Ctrl+C/V · Delete · ↑/↓</span>
      </div>
      <table className="w-full min-w-[900px] border-collapse text-[18px]">
        <thead><tr className="bg-[var(--table-header-bg)] text-[var(--navy)]">
          <th className="w-[34%] border-r-2 border-[var(--navy)] px-4 py-3 text-left font-extrabold">Unit</th>
          <th className="px-4 py-3 text-left font-extrabold">Summary</th>
        </tr></thead>
        <tbody>
          {rows.map((row, index) => {
            const previous = rows[index - 1];
            const startsProperty = !previous || previous.propertyId !== row.propertyId;
            const selected = selectedId === row.apartmentId;
            const editing = editingId === row.apartmentId;
            const state = saveStates[row.apartmentId] ?? "idle";
            return (
              <tr key={row.apartmentId} className={cn("border-b border-[var(--border)]", startsProperty && "border-t-2 border-t-[var(--gold)]")}>
                <th className="select-text border-r-2 border-[var(--navy)] bg-[var(--page-bg)] px-4 py-3 text-left font-extrabold text-[var(--navy)]">{row.propertyName} <span className="font-mono">{row.unitCode}</span></th>
                <td
                  ref={(node) => { if (node) cellRefs.current.set(row.apartmentId, node); else cellRefs.current.delete(row.apartmentId); }}
                  tabIndex={selected ? 0 : -1}
                  onFocus={() => setSelectedId(row.apartmentId)}
                  onClick={() => setSelectedId(row.apartmentId)}
                  onDoubleClick={() => setEditingId(row.apartmentId)}
                  onKeyDown={(event) => { void selectedKeyDown(event, row); }}
                  className={cn("relative h-14 cursor-cell px-3 py-2 outline-none", selected && "z-[1] ring-2 ring-inset ring-emerald-600")}
                >
                  {editing ? (
                    <input
                      ref={inputRef}
                      value={notes[row.apartmentId] ?? ""}
                      maxLength={500}
                      onChange={(event) => change(row.apartmentId, event.target.value)}
                      onBlur={() => { setEditingId(null); void persist(row.apartmentId, notes[row.apartmentId] ?? ""); }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); move(row.apartmentId, 1); }
                        if (event.key === "Escape") { event.preventDefault(); setEditingId(null); }
                      }}
                      className="h-10 w-full border-0 bg-transparent px-1 text-[18px] outline-none"
                    />
                  ) : <span className="block min-h-7 whitespace-pre-wrap break-words">{notes[row.apartmentId] ?? ""}</span>}
                  <span className={cn("absolute right-2 top-1 text-[11px]", state === "error" ? "text-red-600" : "text-muted-foreground")}>
                    {state === "saving" ? "Saving…" : state === "saved" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : state === "error" ? "Save failed" : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
