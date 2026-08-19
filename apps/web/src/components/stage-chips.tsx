type StageChipData = {
  stageKey: string;
  stageLabel: string;
  status: "pending" | "in_progress" | "completed";
};

const CHIP_CLASS: Record<StageChipData["status"], string> = {
  pending:
    "bg-[var(--card-bg)] text-[var(--text-muted)] border-[var(--card-border)]",
  in_progress: "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-400",
  completed: "bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-400",
};

type Props = { stages: StageChipData[] };

export function StageChips({ stages }: Props) {
  return (
    <div className="flex flex-wrap gap-1">
      {stages.map((s) => (
        <span
          key={s.stageKey}
          data-status={s.status}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${CHIP_CLASS[s.status]}`}
        >
          {s.stageLabel}
        </span>
      ))}
    </div>
  );
}
