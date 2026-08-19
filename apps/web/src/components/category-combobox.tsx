import { useEffect, useState } from "react";
import { useActiveWorkCategories } from "@/hooks/use-work-categories";

interface Props {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
}

const OTHER = "Other";

/**
 * Controlled category field backed by the admin-managed WorkCategory list.
 * A <select> of active category names + "Other" (free text). The committed
 * value is the chosen name, or the typed string in Other mode.
 * Selecting "Other" emits "" until the user types; the free-text box stays
 * open via `choseOther` state (mirrors the original pattern).
 */
export function CategoryCombobox({ value, onChange, id = "category", label, hint, disabled }: Props) {
  const { data: categories = [] } = useActiveWorkCategories();
  const names = categories.map((c) => c.name);
  // A value that isn't in the list (and isn't empty) is already "Other mode".
  const valueIsNonListed = value !== "" && !names.includes(value);
  // Tracks an explicit "Other" pick whose free-text is still empty.
  const [choseOther, setChoseOther] = useState(valueIsNonListed);

  // Sync mode when the parent supplies a new value (edit-load / reset).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: keeps the 'Other' toggle in sync with the current value, including mid-typing
    if (value !== "" && names.includes(value)) setChoseOther(false);
    else if (valueIsNonListed) setChoseOther(true);
    // value === "" and not listed: leave as-is (mid "Other" typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, valueIsNonListed]);

  const otherMode = valueIsNonListed || choseOther;
  const selectValue = otherMode ? OTHER : value;

  return (
    <div className="flex flex-col gap-1.5">
      {label ? <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">{label}</label> : null}
      <select
        id={id}
        role="combobox"
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        value={selectValue}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER) { setChoseOther(true); onChange(""); }
          else { setChoseOther(false); onChange(next); }
        }}
      >
        <option value="">Select a category…</option>
        {names.map((c) => (<option key={c} value={c}>{c}</option>))}
        <option value={OTHER}>Other</option>
      </select>
      {otherMode ? (
        <input
          type="text"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="Specify the category"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
      {hint ? <span className="text-xs text-[var(--text-muted)]">{hint}</span> : null}
    </div>
  );
}
