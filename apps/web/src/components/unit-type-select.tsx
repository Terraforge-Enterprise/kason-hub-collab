import type { RoomTypeOption } from "@/hooks/use-room-types";

export type UnitTypeSelectProps = {
  value: string;
  onChange: (next: string) => void;
  options: RoomTypeOption[];
  /** When set, options of the off-mode are visible but disabled. */
  lockMode?: "WHOLE" | "PARTITIONED" | null;
  /** Names to hide entirely (e.g. already-used sibling unit types). */
  excludeNames?: string[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
};

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

export function UnitTypeSelect({
  value,
  onChange,
  options,
  lockMode = null,
  excludeNames = [],
  disabled = false,
  className = "",
  placeholder = "Pick a type…",
}: UnitTypeSelectProps) {
  const excluded = new Set(excludeNames);
  const whole = options.filter((o) => o.kind === "WHOLE" && !excluded.has(o.name));
  const partition = options.filter((o) => o.kind === "PARTITION" && !excluded.has(o.name));

  const lockTip = (locked: boolean, target: "Whole" | "Per-room") =>
    locked
      ? target === "Whole"
        ? "This unit is rented per-room — can't mix with whole-unit types."
        : "This unit is rented as a whole — can't mix with per-room types."
      : undefined;

  const wholeLocked = lockMode === "PARTITIONED";
  const partitionLocked = lockMode === "WHOLE";

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`${INPUT_BASE} ${className}`}
    >
      <option value="">{placeholder}</option>
      {whole.length > 0 && (
        <optgroup label={wholeLocked ? "Whole (locked)" : "Whole"} disabled={wholeLocked}>
          {whole.map((o) => (
            <option key={o.id} value={o.name} disabled={wholeLocked} title={lockTip(wholeLocked, "Whole")}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
      {partition.length > 0 && (
        <optgroup label={partitionLocked ? "Partitioned (locked)" : "Partitioned"} disabled={partitionLocked}>
          {partition.map((o) => (
            <option key={o.id} value={o.name} disabled={partitionLocked} title={lockTip(partitionLocked, "Per-room")}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
