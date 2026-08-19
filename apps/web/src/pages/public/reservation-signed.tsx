import { useLocation } from "react-router-dom";
import { CheckCircle2, Download, Mail } from "lucide-react";

export default function ReservationSignedPage() {
  const { state } = useLocation() as { state?: { pdfUrl?: string } };
  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-amber-50/30 to-zinc-50 dark:from-zinc-950 dark:via-amber-950/10 dark:to-zinc-950">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 py-16">
        {/* Brand */}
        <div className="mb-10 flex items-center gap-2">
          <div className="h-[18px] w-[3px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
            Unit Reservation
          </span>
        </div>

        {/* Success card */}
        <div className="w-full overflow-hidden rounded-3xl border border-amber-200/60 bg-white shadow-[0_30px_80px_-20px_rgba(184,150,62,0.25)] dark:border-amber-800/30 dark:bg-zinc-900">
          {/* Top gold strip */}
          <div className="h-1.5 bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />

          <div className="px-8 py-10 text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 ring-8 ring-emerald-50 dark:bg-emerald-900/50 dark:ring-emerald-950">
              <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
            </div>

            <h1 className="mb-3 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              Thank you
            </h1>
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Your reservation form has been signed and recorded. A copy of the signed document
              has been sent to your email for your records.
            </p>

            {state?.pdfUrl && (
              <a
                href={state.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-7 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_28px_-8px_rgba(184,150,62,0.5)] transition-all hover:shadow-[0_16px_32px_-6px_rgba(184,150,62,0.6)] hover:brightness-105"
              >
                <Download className="h-4 w-4" />
                Download signed PDF
              </a>
            )}

            <div className="mx-auto mt-8 flex max-w-xs items-center justify-center gap-2 rounded-full border border-zinc-200/80 bg-zinc-50/60 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-400">
              <Mail className="h-3 w-3" />
              Confirmation also sent via email
            </div>
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-zinc-500 dark:text-zinc-500">
          You may close this window. Your agent has been notified.
        </p>
      </div>
    </div>
  );
}
