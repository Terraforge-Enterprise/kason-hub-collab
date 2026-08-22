import type { ComponentType, CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { GlowCard } from "@/components/ui/glow-card";

type GlowColor = "blue" | "purple" | "green" | "red" | "orange" | "gold";
type IconType = ComponentType<{ className?: string }>;

const METRIC_ROTATION: GlowColor[] = ["purple", "blue", "green", "orange"];
const METRIC_ICON_BG: Record<GlowColor, string> = {
  purple: "bg-purple-500/10",
  blue: "bg-blue-500/10",
  green: "bg-green-500/10",
  orange: "bg-orange-500/10",
  red: "bg-red-500/10",
  gold: "bg-amber-500/10",
};
const METRIC_ICON_FG: Record<GlowColor, string> = {
  purple: "text-purple-600 dark:text-purple-400",
  blue: "text-blue-600 dark:text-blue-400",
  green: "text-green-600 dark:text-green-400",
  orange: "text-orange-600 dark:text-orange-400",
  red: "text-red-600 dark:text-red-400",
  gold: "text-amber-600 dark:text-amber-400",
};

type Metric = {
  label: string;
  value: string;
  hint?: string;
  icon?: IconType;
  glowColor?: GlowColor;
};

export function PageHeader({
  title,
  description,
  metrics,
  actions,
  icon: HeaderIcon,
  compact = false,
}: {
  title: string;
  description?: string;
  metrics?: Metric[];
  actions?: ReactNode;
  icon?: IconType;
  compact?: boolean;
}) {
  return (
    <section className={compact ? "space-y-3" : "space-y-6"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className={cn(
            "font-display flex items-center font-bold text-[var(--navy-text)] dark:text-foreground",
            compact ? "gap-2 text-2xl" : "gap-3 text-3xl md:text-4xl",
          )}>
            {HeaderIcon ? <HeaderIcon className={cn("shrink-0 text-[var(--gold-dark)] dark:text-[var(--gold-light)]", compact ? "h-6 w-6" : "h-8 w-8")} /> : null}
            <span className="min-w-0">{title}</span>
          </h1>
          {description ? <p className={cn("mt-1 text-muted-foreground", compact && "text-xs")}>{description}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {metrics?.length ? (
        <div className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4", compact ? "gap-2" : "gap-4")}>
          {metrics.map((m, i) => {
            const color = m.glowColor ?? METRIC_ROTATION[i % METRIC_ROTATION.length];
            const Icon = m.icon;
            return (
              <GlowCard
                key={m.label}
                glowColor={color}
                className={cn(
                  "border border-[var(--card-border)] bg-card shadow-[var(--card-shadow)]",
                  compact ? "p-3" : "p-6",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className={cn("min-w-0", compact ? "space-y-0.5" : "space-y-2")}>
                    <p className={cn("font-medium text-muted-foreground", compact ? "text-xs" : "text-sm")}>{m.label}</p>
                    <p className={cn("break-words font-bold text-foreground", compact ? "text-xl leading-tight" : "text-3xl")}>{m.value}</p>
                    {m.hint ? <p className={cn("text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>{m.hint}</p> : null}
                  </div>
                  {Icon ? (
                    <div className={cn("shrink-0 rounded-xl", compact ? "p-2" : "p-3", METRIC_ICON_BG[color])}>
                      <Icon className={cn(compact ? "h-4 w-4" : "h-6 w-6", METRIC_ICON_FG[color])} />
                    </div>
                  ) : null}
                </div>
              </GlowCard>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export function Surface({
  title,
  description,
  children,
  className,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--card-border)] bg-card shadow-[var(--card-shadow)]",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between border-b border-[var(--card-border)] bg-[#F8FAFC] px-4 py-3 dark:bg-muted lg:px-5">
          <div>
            <h2 className="text-sm font-bold text-[var(--navy-text)] dark:text-foreground">{title}</h2>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div>{actions}</div> : null}
        </div>
      ) : null}
      <div className="px-4 py-4 lg:px-5">{children}</div>
    </section>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border border-[var(--card-border)] bg-white dark:bg-card">
      {children}
    </div>
  );
}

export function DataTable({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <table className={cn("min-w-full border-collapse text-left text-sm", className)} style={style}>{children}</table>;
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-[var(--card-border)] bg-[var(--table-head)] text-[10px] uppercase tracking-widest text-[var(--navy-text)]">
      {children}
    </thead>
  );
}

export function HeadCell({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn("px-4 py-3 font-bold text-[var(--navy-text)]", className)}>{children}</th>;
}

export function BodyCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("max-w-[24rem] px-4 py-3.5 text-sm text-[var(--text-primary)] [overflow-wrap:anywhere]", className)}>{children}</td>;
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]">{children}</tr>;
}

export function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
        {label}
      </td>
    </tr>
  );
}

export function StatusPill({
  children,
  tone = "slate",
  className,
  testId,
}: {
  children: ReactNode;
  tone?: "slate" | "sky" | "emerald" | "amber" | "rose";
  className?: string;
  /** Optional `data-testid` on the rendered badge. A bare `data-testid={…}` written at a
   * call site would be SILENTLY DROPPED — TypeScript does not excess-check hyphenated JSX
   * attributes, so it type-checks and then never reaches the DOM. Additive: existing
   * callers render byte-identically. */
  testId?: string;
}) {
  const variantByTone = {
    slate: "outline",
    sky: "sky",
    emerald: "emerald",
    amber: "amber",
    rose: "rose",
  } as const;
  const displayChildren =
    typeof children === "string" && children.length > 0
      ? `${children.charAt(0).toUpperCase()}${children.slice(1)}`
      : children;

  return <Badge variant={variantByTone[tone]} className={className} data-testid={testId}>{displayChildren}</Badge>;
}

export function BulletList({ children }: { children: ReactNode }) {
  return <ul className="space-y-1 pl-4 text-sm text-[var(--text-secondary)]">{children}</ul>;
}
