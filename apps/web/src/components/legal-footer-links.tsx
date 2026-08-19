import { Link } from "react-router-dom";
import { LEGAL_PAGES } from "@/pages/public/legal/legal-layout";
import { COMPANY_LEGAL_LINE } from "@/lib/company-info";

/**
 * Cross-links to the five public compliance pages.
 *
 * Mount this on every surface a logged-out visitor or a payment-gateway
 * reviewer can reach — the two login pages and the payment page at minimum.
 *
 * WHY THE LOGIN PAGES MATTER: `workspace.kaenproperties.com/` redirects to
 * /dashboard, which bounces an unauthenticated visitor to /login. That makes
 * the login screen the de-facto landing page for anyone reviewing the merchant
 * site, so it is the one place the policy links cannot be omitted.
 *
 * WHY THE PAY PAGE MATTERS: Fiuu ToS cl. 3.9 requires the refund policy and
 * trading details to be discoverable at the point of purchase, not merely
 * somewhere on the site.
 */
export function LegalFooterLinks({
  className = "",
  showEntity = false,
}: {
  className?: string;
  showEntity?: boolean;
}) {
  return (
    <div className={`text-center ${className}`}>
      <nav
        aria-label="Legal and company information"
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5"
      >
        {LEGAL_PAGES.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            className="text-[11px] text-[var(--text-muted)] underline-offset-4 transition hover:text-[#B8963E] hover:underline"
          >
            {p.label}
          </Link>
        ))}
      </nav>
      {showEntity && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">{COMPANY_LEGAL_LINE}</p>
      )}
    </div>
  );
}

export default LegalFooterLinks;
