import type { ReactNode } from "react";

type DashboardHeaderProps = {
  leftSlot?: ReactNode;
  children?: ReactNode;
};

export function DashboardHeader({ leftSlot, children }: DashboardHeaderProps) {
  const orgName = "KAEN Properties";
  const todayLabel = new Intl.DateTimeFormat("en-MY", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--card-bg)] px-4 lg:px-6">
      <div className="flex items-center gap-3">
        {leftSlot}
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] lg:hidden">
          <span className="text-xs font-bold text-white">K</span>
        </div>
        <div className="hidden sm:block">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{orgName}</p>
          <p className="text-xs text-[var(--text-muted)]">{todayLabel}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {children}
      </div>
    </header>
  );
}
