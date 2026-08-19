// Presentational property-type picker. Auth-agnostic: it only ever sees
// `options` as a prop — admin callers pass useActivePropertyTypes(), portal
// callers pass usePortalPropertyTypes(). A native controlled <select> so
// callers own the value.
export type PropertyTypeSelectProps = {
  value: string;
  onChange: (next: string) => void;
  options: { id: string; name: string }[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
};

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

export function PropertyTypeSelect({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
  placeholder = "Pick a type…",
}: PropertyTypeSelectProps) {
  // Preserve an off-catalog (legacy) stored value: render it as a synthetic
  // selected option so opening an existing property never blanks/force-changes
  // its stored type.
  const inCatalog = value !== "" && options.some((o) => o.name === value);
  const isLegacy = value !== "" && !inCatalog;

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`${INPUT_BASE} ${className}`}
    >
      <option value="">{placeholder}</option>
      {isLegacy && <option value={value}>{`${value} (current)`}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
