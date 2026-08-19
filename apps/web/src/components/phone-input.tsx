import { useEffect, useId, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { normalizeMyPhone } from "@kason/shared";
import { cn } from "@/lib/utils";

type PhoneInputProps = {
  value: string | null;
  onChange: (canonical: string | null) => void;
  onValidityChange?: (state: "empty" | "valid" | "invalid") => void;
  label?: string;
  error?: string;
  required?: boolean;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
};

/**
 * Locked-prefix Malaysian phone input. Visually shows "+60" as a non-input
 * span; the <input> only holds national digits. Parent state holds the
 * canonical form (e.g. "60123456789") which is what schemas validate and
 * what the API stores.
 */
export function PhoneInput({
  value,
  onChange,
  onValidityChange,
  label,
  error,
  required,
  name,
  placeholder = "12-345 6789",
  disabled,
}: PhoneInputProps) {
  const [display, setDisplay] = useState<string>(() => stripCountry(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const invalidRef = useRef(false);
  const errorId = useId();

  useEffect(() => {
    // Don't clobber an in-progress edit. Parent should only learn the canonical
    // on blur; if it does push a new value while we're focused, ignore it.
    if (document.activeElement === inputRef.current) return;
    if (invalidRef.current) return; // don't clobber a pending-invalid entry
    setDisplay(stripCountry(value));
  }, [value]);

  function handleBlur() {
    const raw = display.trim();
    if (!raw) {
      invalidRef.current = false;
      onChange(null);
      onValidityChange?.("empty");
      return;
    }
    const canonical = normalizeMyPhone(display);
    if (canonical) {
      invalidRef.current = false;
      setDisplay(canonical.slice(2));
      onChange(canonical);
      onValidityChange?.("valid");
    } else {
      invalidRef.current = true; // keep the typed text; report invalid
      onChange(null);
      onValidityChange?.("invalid");
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    const canonical = normalizeMyPhone(pasted);
    if (canonical) {
      e.preventDefault();
      invalidRef.current = false;
      setDisplay(canonical.slice(2));
      onChange(canonical);
      onValidityChange?.("valid");
    }
  }

  return (
    <label className="grid gap-1.5">
      {label && (
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </span>
      )}
      <div
        className={cn(
          "flex min-h-10 w-full items-stretch overflow-hidden rounded-lg border bg-[var(--card-bg)] transition focus-within:ring-2",
          error
            ? "border-red-500 focus-within:ring-red-200"
            : "border-[var(--input-border)] focus-within:border-[var(--primary)] focus-within:ring-[var(--ring)]",
          disabled && "opacity-60",
        )}
      >
        <span className="flex items-center border-r border-[var(--input-border)] bg-transparent px-3 text-sm text-[var(--text-secondary)]">
          +60
        </span>
        <input
          ref={inputRef}
          type="tel"
          name={name}
          value={display}
          onChange={(e) => { invalidRef.current = false; setDisplay(e.target.value); }}
          onBlur={handleBlur}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="min-h-10 flex-1 bg-transparent px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          inputMode="numeric"
          autoComplete="tel-national"
        />
      </div>
      {error && <span id={errorId} className="text-xs text-red-500">{error}</span>}
    </label>
  );
}

function stripCountry(canonical: string | null): string {
  if (!canonical) return "";
  if (canonical.startsWith("60")) return canonical.slice(2);
  return canonical;
}
