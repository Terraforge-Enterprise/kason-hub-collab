import { Info, AlertTriangle, AlertCircle, CheckCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Variant = "info" | "warning" | "danger" | "success";

type CalloutProps = {
  variant?: Variant;
  title?: string;
  icon?: LucideIcon;
  className?: string;
  children: React.ReactNode;
};

// ── Config ─────────────────────────────────────────────────────────────────────

const VARIANT_STYLES: Record<Variant, { wrapper: string; icon: string; IconDefault: LucideIcon }> = {
  info: {
    wrapper:
      "bg-sky-50 border-sky-200 text-sky-900 " +
      "dark:bg-sky-500/15 dark:border-sky-500/30 dark:text-sky-100",
    icon: "text-sky-700 dark:text-sky-400",
    IconDefault: Info,
  },
  warning: {
    wrapper:
      "bg-amber-50 border-amber-200 text-amber-900 " +
      "dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-100",
    icon: "text-amber-700 dark:text-amber-400",
    IconDefault: AlertTriangle,
  },
  danger: {
    wrapper:
      "bg-rose-50 border-rose-200 text-rose-900 " +
      "dark:bg-rose-500/15 dark:border-rose-500/40 dark:text-rose-100",
    icon: "text-rose-700 dark:text-rose-400",
    IconDefault: AlertCircle,
  },
  success: {
    wrapper:
      "bg-emerald-50 border-emerald-200 text-emerald-900 " +
      "dark:bg-emerald-500/15 dark:border-emerald-500/40 dark:text-emerald-100",
    icon: "text-emerald-700 dark:text-emerald-400",
    IconDefault: CheckCircle,
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Callout — banner-style inline alert for notes, warnings, errors, and
 * confirmations. Use for sentences of contextual information, not tiny status
 * pills (use Badge for those).
 *
 * Contrast-safe in BOTH modes:
 * - Light: 50-level background, 200 border, 900 text, 700 icon
 * - Dark:  500/15 background, 500/30-40 border, 100 text, 400 icon
 * Both pass WCAG AA. Portal/login pages have no theme toggle and follow the
 * system preference, so light-mode contrast is non-negotiable.
 *
 * @example
 * <Callout variant="warning" title="Heads up">
 *   Saving will flip this claim back to Amended and require admin re-approval.
 * </Callout>
 */
export function Callout({
  variant = "info",
  title,
  icon,
  className,
  children,
}: CalloutProps) {
  const styles = VARIANT_STYLES[variant];
  const Icon = icon ?? styles.IconDefault;

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-sm flex gap-3",
        styles.wrapper,
        className,
      )}
    >
      <Icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", styles.icon)} />
      <div className="flex-1 min-w-0">
        {title && (
          <span className="font-semibold">{title}: </span>
        )}
        {children}
      </div>
    </div>
  );
}
