import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import { Callout } from "@/components/ui/callout";

type PaymentItem = {
  id: string; paymentNumber: string; paymentMethod: string; status: string;
  amount: number; currency: string; receivedAt: string; referenceNote: string | null;
};

type PaginatedResponse = {
  data: PaymentItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

type FpxOutcome = "success" | "failed";

export default function PortalPaymentsPage() {
  const [page, setPage] = useState(1);

  // FPX return banner — the gateway/mock returns the payer to
  // /portal/payments?fpx=success|failed. Read it once, then strip the param so a
  // refresh or back-nav doesn't re-show the banner; a local state drives the
  // (dismissible) banner thereafter.
  const [searchParams, setSearchParams] = useSearchParams();
  const [fpxBanner, setFpxBanner] = useState<FpxOutcome | null>(null);
  useEffect(() => {
    const fpx = searchParams.get("fpx");
    if (fpx === "success" || fpx === "failed") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: consumes the FPX redirect query param once, then strips it from the URL
      setFpxBanner(fpx);
      const next = new URLSearchParams(searchParams);
      next.delete("fpx");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const { data, isLoading } = useQuery({
    queryKey: ["portal-payments", page],
    queryFn: () => portalApiFetch<PaginatedResponse>(`/payments?page=${page}&limit=20`),
  });

  const payments = data?.data ?? [];
  const pagination = data?.pagination;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Payment History</h1>

      {fpxBanner && (
        <Callout variant={fpxBanner === "success" ? "success" : "danger"}>
          <div className="flex items-start justify-between gap-3">
            <span>
              {fpxBanner === "success"
                ? "Your payment was received."
                : "Your payment didn't complete — please try again."}
            </span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setFpxBanner(null)}
              className="shrink-0 rounded p-0.5 opacity-70 transition hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Callout>
      )}

      {isLoading ? (
        <div className="animate-pulse text-sm text-[var(--text-secondary)]">Loading...</div>
      ) : (
        <div className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--page-bg)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Payment #</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Method</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-secondary)]">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-[var(--page-bg)] last:border-0">
                  <td className="px-4 py-3 text-[var(--text-primary)]">{p.paymentNumber}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{p.paymentMethod}</td>
                  <td className="px-4 py-3 text-[var(--text-secondary)]">{p.receivedAt.slice(0, 10)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-[var(--text-primary)]">RM {p.amount.toFixed(2)}</td>
                  <td className="px-4 py-3"><span className="rounded-full bg-[var(--card-bg)] border border-[var(--card-border)] px-2 py-0.5 text-xs">{p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 rounded border border-[var(--input-border)] disabled:opacity-30">Prev</button>
            <button onClick={() => setPage((p) => p + 1)} disabled={page >= pagination.totalPages} className="px-3 py-1 rounded border border-[var(--input-border)] disabled:opacity-30">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
