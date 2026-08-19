import type { RoomTypeOption } from "@/hooks/use-room-types";
import { UnitTypeSelect } from "@/components/unit-type-select";

export type UnitMode = "WHOLE" | "PARTITIONED";

const MODES: { key: UnitMode; label: string; hint: string }[] = [
  { key: "WHOLE", label: "Whole Unit", hint: "One tenant rents the entire unit." },
  { key: "PARTITIONED", label: "Partition", hint: "Rooms are rented individually." },
];

// A RoomTypeOption whose kind matches the chosen mode.
function kindForMode(mode: UnitMode): RoomTypeOption["kind"] {
  return mode === "WHOLE" ? "WHOLE" : "PARTITION";
}

/**
 * Two-step unit-type picker. Step 1 is a Whole | Partition segmented control;
 * step 2 is the existing {@link UnitTypeSelect}, disabled until a mode is
 * chosen and with the off-mode option group locked. On EDIT the caller passes
 * the mode already inferred from the saved type, so the operator is never
 * forced to re-pick.
 */
export function UnitTypeStep({
  value,
  mode,
  onChange,
  onModeChange,
  options,
  disabled = false,
  hideTypeSelect = false,
}: {
  value: string;
  mode: UnitMode | null;
  onChange: (next: string) => void;
  onModeChange: (next: UnitMode) => void;
  options: RoomTypeOption[];
  disabled?: boolean;
  /** Hide the step-2 type dropdown, keeping only the Whole|Partition mode
   *  buttons. The Create dialog's Partition path sets this: per-room types live
   *  in the room strip, so a top-level type is orphaned (buildPartitionPayload
   *  never maps it). Default off — the Edit dialog and the Whole path always
   *  render the dropdown. */
  hideTypeSelect?: boolean;
}) {
  function pickMode(next: UnitMode) {
    if (next === mode) return;
    onModeChange(next);
    // Clear a selection belonging to the mode we just left, so an off-mode
    // unitType can never reach the server and trip LISTING_MODE_MISMATCH.
    const current = options.find((o) => o.name === value);
    if (current && current.kind !== kindForMode(next)) onChange("");
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={mode === m.key}
            onClick={() => pickMode(m.key)}
            disabled={disabled}
            className={`rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-60 ${
              mode === m.key
                ? "border-[var(--primary)] bg-[var(--primary)]/10"
                : "border-[var(--card-border)] bg-[var(--card-bg)] hover:border-[var(--primary)]/60"
            }`}
          >
            <span className="block font-medium">{m.label}</span>
            <span className="block text-xs text-[var(--text-secondary)]">{m.hint}</span>
          </button>
        ))}
      </div>
      {!hideTypeSelect && (
        // Same 2-col grid as the mode cards above, so the step-2 dropdown fills
        // the first column and lines up with the "Whole Unit" card's edges
        // instead of floating as a narrow stub under them.
        <div className="grid gap-2 sm:grid-cols-2">
          <UnitTypeSelect
            className="w-full"
            value={value}
            onChange={onChange}
            options={options}
            lockMode={mode}
            disabled={disabled || mode === null}
            placeholder={mode === null ? "Pick Whole or Partition first…" : "Pick a type…"}
          />
        </div>
      )}
    </div>
  );
}
