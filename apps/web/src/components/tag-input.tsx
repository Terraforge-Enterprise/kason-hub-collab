// Generic free-form chip input. Comma or Enter commits the draft; click X to
// remove a chip; Backspace at an empty draft pops the last chip. Used for
// unit Highlights and any other ad-hoc tag list — kept here (shared
// components/) rather than in a specific page module so admin and portal
// can both consume without crossing role-envelope boundaries.

import { useState } from "react";
import { X } from "lucide-react";

export function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  return (
    <div className="rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-2 focus-within:ring-2 focus-within:ring-[var(--ring)]">
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs"
          >
            <span className="capitalize">{v}</span>
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${v}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          placeholder={values.length === 0 ? (placeholder ?? "parking, gym, pool…") : ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>
    </div>
  );
}
