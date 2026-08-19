import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";

export function TenantConfirmCard({
  tenantPartyId,
  displayName,
  idNumberMasked,
  phone,
  onChangeTenant,
}: {
  tenantPartyId: string;
  displayName: string;
  idType: string | null;
  idNumberMasked: string | null;
  phone: string | null;
  onChangeTenant: () => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);

  const reveal = useMutation({
    mutationFn: () =>
      apiFetch<{ partyId: string; idNumber: string }>(`/parties/${tenantPartyId}/ic-reveal`, {
        method: "POST",
        body: JSON.stringify({ partyId: tenantPartyId }),
      }),
    onSuccess: (data) => setRevealed(data.idNumber),
    onError: (err: Error) => toast.error(err.message || "Could not reveal IC."),
  });

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">{displayName}</span>
        <button
          type="button"
          onClick={onChangeTenant}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Change tenant
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">IC</dt>
        <dd className="flex items-center gap-2 font-mono">
          {revealed ?? idNumberMasked ?? "—"}
          {idNumberMasked && revealed === null && (
            <button
              type="button"
              onClick={() => reveal.mutate()}
              disabled={reveal.isPending}
              className="font-sans text-xs text-[var(--primary)] hover:underline disabled:opacity-50"
            >
              {reveal.isPending ? "Revealing…" : "Reveal IC"}
            </button>
          )}
        </dd>
        <dt className="text-slate-500">Phone</dt>
        <dd className="font-mono">{phone ?? "—"}</dd>
      </dl>
    </div>
  );
}
