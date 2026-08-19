import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { COMPANY, COMPANY_ADDRESS_ONELINE, COMPANY_LEGAL_LINE } from "@/lib/company-info";

/**
 * Chrome shared by the five public compliance pages.
 *
 * These pages MUST render without a session. Fiuu's onboarding reviewer cannot
 * log in, and CPETTR 2024 disclosure is owed to consumers before they transact
 * — so this layout deliberately depends on no auth context, no API call and no
 * provider beyond the router. Do not wrap these routes in ProtectedRoute or
 * PortalProtectedRoute.
 *
 * The footer repeats the full legal-entity block on every page so the required
 * disclosure is present wherever a reviewer or consumer lands, and cross-links
 * all five pages so they can be reached from any one of them.
 */

export const LEGAL_PAGES = [
  { to: "/about", label: "About Us" },
  { to: "/terms", label: "Terms & Conditions" },
  { to: "/privacy", label: "Privacy Policy" },
  { to: "/refund-policy", label: "Return & Refund Policy" },
  { to: "/contact", label: "Contact Us" },
] as const;

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        {children}
      </div>
    </section>
  );
}

export default function LegalLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-amber-50/30 to-zinc-50 dark:from-zinc-950 dark:via-amber-950/10 dark:to-zinc-950">
      <div className="mx-auto max-w-3xl px-6 py-12 md:py-16">
        {/* Brand */}
        <Link to="/about" className="mb-10 inline-flex items-center gap-2">
          <div className="h-[18px] w-[3px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
            {COMPANY.tradingName}
          </span>
        </Link>

        <article className="overflow-hidden rounded-3xl border border-amber-200/60 bg-white shadow-[0_30px_80px_-20px_rgba(184,150,62,0.25)] dark:border-amber-800/30 dark:bg-zinc-900">
          <div className="h-1.5 bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />

          <div className="px-6 py-10 md:px-10">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </h1>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
              Last updated {COMPANY.policyLastUpdated}
            </p>
            {intro && (
              <p className="mt-5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                {intro}
              </p>
            )}

            <div className="mt-8">{children}</div>
          </div>
        </article>

        {/* Cross-links — every compliance page reachable from every other. */}
        <nav
          aria-label="Legal and company information"
          className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
        >
          {LEGAL_PAGES.map((p) => (
            <Link
              key={p.to}
              to={p.to}
              className="text-xs text-zinc-600 underline-offset-4 transition hover:text-[#B8963E] hover:underline dark:text-zinc-400"
            >
              {p.label}
            </Link>
          ))}
        </nav>

        {/*
          CPETTR 2024 disclosure block — business name, SSM registration number,
          address, email and telephone. Repeated on every page by design.
        */}
        <footer className="mt-6 border-t border-zinc-200/70 pt-6 text-center text-xs leading-relaxed text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">{COMPANY_LEGAL_LINE}</p>
          <p className="mt-1">{COMPANY_ADDRESS_ONELINE}</p>
          <p className="mt-1">
            <a href={`tel:${COMPANY.phoneE164}`} className="hover:text-[#B8963E]">
              {COMPANY.phone}
            </a>
            {" · "}
            <a href={`mailto:${COMPANY.supportEmail}`} className="hover:text-[#B8963E]">
              {COMPANY.supportEmail}
            </a>
          </p>
          <p className="mt-3 text-[11px]">
            Versi Bahasa Malaysia bagi dasar-dasar ini boleh diperoleh dengan menghubungi kami di{" "}
            {COMPANY.supportEmail}.
          </p>
        </footer>
      </div>
    </div>
  );
}
