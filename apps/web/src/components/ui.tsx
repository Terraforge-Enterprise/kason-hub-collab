import type { ComponentType, ReactNode } from "react";
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
}: {
  title: string;
  description?: string;
  metrics?: Metric[];
  actions?: ReactNode;
  icon?: IconType;
}) {
  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
            {HeaderIcon ? <HeaderIcon className="h-8 w-8 shrink-0 text-primary" /> : null}
            <span className="min-w-0">{title}</span>
          </h1>
          {description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {metrics?.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {metrics.map((m, i) => {
            const color = m.glowColor ?? METRIC_ROTATION[i % METRIC_ROTATION.length];
            const Icon = m.icon;
            return (
              <GlowCard
                key={m.label}
                glowColor={color}
                className="border border-border/50 bg-background/40 p-6 backdrop-blur-xl"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">{m.label}</p>
                    <p className="break-words text-3xl font-bold text-foreground">{m.value}</p>
                    {m.hint ? <p className="text-xs text-muted-foreground">{m.hint}</p> : null}
                  </div>
                  {Icon ? (
                    <div className={cn("shrink-0 rounded-xl p-3", METRIC_ICON_BG[color])}>
                      <Icon className={cn("h-6 w-6", METRIC_ICON_FG[color])} />
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
        "overflow-hidden rounded-xl border border-border/50 bg-background/60 shadow-xl backdrop-blur-xl",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3 lg:px-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
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
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      {children}
    </div>
  );
}

export function DataTable({ children }: { children: ReactNode }) {
  return <table className="min-w-full border-collapse text-left text-sm">{children}</table>;
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
      {children}
    </thead>
  );
}

export function HeadCell({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn("px-4 py-3 font-semibold", className)}>{children}</th>;
}

export function BodyCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-4 py-3.5 text-sm text-[var(--text-primary)]", className)}>{children}</td>;
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
  return <Badge variant={variantByTone[tone]} className={className} data-testid={testId}>{children}</Badge>;
}

export function BulletList({ children }: { children: ReactNode }) {
  return <ul className="space-y-1 pl-4 text-sm text-[var(--text-secondary)]">{children}</ul>;
}
