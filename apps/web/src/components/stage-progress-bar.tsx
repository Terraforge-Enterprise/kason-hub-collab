type Props = { completed: number; total: number };

export function StageProgressBar({ completed, total }: Props) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>{completed} of {total} stages</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--card-border)] overflow-hidden">
        <div
          className="h-full bg-[var(--gold)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
