export function OwnerConfirmCard({
  ownerName,
  ownerPhone,
  onChange,
}: {
  ownerName: string;
  ownerPhone?: string | null;
  onChange: () => void;
}) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">{ownerName}</span>
        <button
          type="button"
          onClick={onChange}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Change owner
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Phone</dt>
        <dd className="font-mono">{ownerPhone ?? "—"}</dd>
      </dl>
    </div>
  );
}
