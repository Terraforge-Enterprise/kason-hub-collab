import type { ButtonHTMLAttributes, FormHTMLAttributes, InputHTMLAttributes, KeyboardEvent, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, WheelEvent } from "react";
import { cn } from "@/lib/utils";

export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("grid gap-5 xl:grid-cols-2", className)}>{children}</section>;
}

export function FormCard({
  title,
  description,
  children,
  className,
  ...props
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
} & FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form
      {...props}
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-sm",
        className,
      )}
    >
      <div className="border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        {description && <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p>}
      </div>
      <div className="grid gap-4 px-5 py-5">{children}</div>
    </form>
  );
}

// Field wraps a labelled input. Pass `error` for server-side field errors
// (renders in red with role=alert); `hint` shows the helper line when no
// error is present. Errors win over hints to keep the layout from shifting.
// Prior to this prop, forms either silently dropped fieldErrors or abused
// `hint` with a className override, both of which dropped accessibility.
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-[var(--text-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * A labelled group of mutually-exclusive options, rendered as pill buttons.
 *
 * Deliberately NOT built on <Field>. Field renders a <label>, and a <label> may
 * name exactly ONE control — wrapping a radio group in it gives EVERY option the
 * same accessible name (the field label and hint, concatenated), so a screen-reader
 * user hears an identical string for every choice and cannot tell them apart.
 * Here the group carries the name via role="radiogroup" + aria-label, and each
 * radio is named by its own text.
 */
export function RadioField<T extends string | number>({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={
                active
                  ? "rounded-lg border border-[#D4AF37]/60 bg-[#D4AF37]/10 px-3 py-2 text-sm font-medium text-[#B8963E] transition-all disabled:opacity-70 dark:text-[#E8CF6D]"
                  : "rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm text-muted-foreground transition-all hover:border-border/80 hover:bg-background/60 disabled:opacity-50"
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {hint ? <span className="text-xs text-[var(--text-muted)]">{hint}</span> : null}
    </div>
  );
}

const fieldClass =
  "min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60 disabled:cursor-not-allowed";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  // Block the browser's wheel-to-increment behaviour on number inputs — accidental
  // scrolls were silently editing values like monthly rent. Blur on wheel so the
  // page scrolls instead; user-supplied onWheel still fires.
  const handleWheel =
    props.type === "number"
      ? (e: WheelEvent<HTMLInputElement>) => {
          e.currentTarget.blur();
          props.onWheel?.(e);
        }
      : props.onWheel;
  // Block "-" on number inputs — Chrome paints the character even when it makes
  // the value invalid, leaving "1200-215" visible while React thinks value="".
  const handleKeyDown =
    props.type === "number"
      ? (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "-") e.preventDefault();
          props.onKeyDown?.(e);
        }
      : props.onKeyDown;
  return (
    <input
      {...props}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      className={cn(fieldClass, props.className)}
    />
  );
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldClass, props.className)} />;
}

export function TextAreaInput(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldClass, "min-h-24 resize-y", props.className)} />;
}

export function ActionButton({
  children,
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  const variants = {
    primary:   "bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)] shadow-sm",
    secondary: "border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:bg-[var(--page-bg)]",
    danger:    "bg-[var(--danger)] text-white hover:bg-red-600 shadow-sm",
  };

  return (
    <button
      {...props}
      className={cn(
        "inline-flex min-h-10 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function FeedbackMessage({ status, message }: { status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle" || !message) return null;
  return (
    <p
      role="alert"
      className={cn(
        "rounded-lg px-4 py-3 text-sm",
        status === "success"
          ? "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "border border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
      )}
    >
      {message}
    </p>
  );
}
