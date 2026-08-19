import { Mail, Phone, MapPin, Clock, MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import LegalLayout, { LegalSection } from "./legal-layout";
import { COMPANY, COMPANY_ADDRESS_ONELINE, COMPANY_LEGAL_LINE } from "@/lib/company-info";

function ContactRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Mail;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
      <div className="rounded-lg bg-amber-500/10 p-2">
        <Icon className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">{label}</p>
        <div className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{children}</div>
      </div>
    </div>
  );
}

export default function ContactPage() {
  return (
    <LegalLayout
      title="Contact Us"
      intro="We would rather hear from you early than late — most billing and payment questions are resolved the same day once we can see the transaction. Here is how to reach us."
    >
      <LegalSection title="How to reach us">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ContactRow icon={Mail} label="Email">
            <a
              href={`mailto:${COMPANY.supportEmail}`}
              className="text-[#B8963E] underline underline-offset-4"
            >
              {COMPANY.supportEmail}
            </a>
          </ContactRow>
          <ContactRow icon={Phone} label="Telephone">
            <a href={`tel:${COMPANY.phoneE164}`} className="text-[#B8963E] underline underline-offset-4">
              {COMPANY.phone}
            </a>
          </ContactRow>
          <ContactRow icon={MessageCircle} label="WhatsApp">
            <a
              href={`https://wa.me/${COMPANY.whatsapp.replace(/[^0-9]/g, "")}`}
              target="_blank"
              rel="noreferrer"
              className="text-[#B8963E] underline underline-offset-4"
            >
              {COMPANY.phone}
            </a>
          </ContactRow>
          <ContactRow icon={Clock} label="Business hours">
            {COMPANY.businessHours}
          </ContactRow>
          <div className="sm:col-span-2">
            <ContactRow icon={MapPin} label="Registered office">
              {COMPANY_LEGAL_LINE}
              <br />
              {COMPANY_ADDRESS_ONELINE}
            </ContactRow>
          </div>
        </div>
      </LegalSection>

      <LegalSection title="When you will hear back">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>General enquiries:</strong> within 1 business day.
          </li>
          <li>
            <strong>Billing and payment queries:</strong> acknowledged within 2 business days.
          </li>
          <li>
            <strong>Refund requests and disputed transactions:</strong> acknowledged within 2
            business days, with an outcome within 14 days — see the{" "}
            <a href="/refund-policy" className="text-[#B8963E] underline underline-offset-4">
              Return &amp; Refund Policy
            </a>
            .
          </li>
          <li>
            <strong>Urgent maintenance</strong> affecting safety, security or water and electricity
            supply: call or WhatsApp rather than email, at any time.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="What to include">
        <p>
          It helps us resolve things on the first reply if you include your name, the unit or
          property address, and — for a payment query — the date, amount and receipt reference of the
          payment concerned.
        </p>
      </LegalSection>

      <LegalSection title="If you are not satisfied">
        <p>
          Ask for your matter to be escalated to management by replying to our response and saying
          so, or by emailing {COMPANY.supportEmail} with &ldquo;Escalation&rdquo; in the subject
          line. We will review and respond within 14 days.
        </p>
        <p>
          If you remain dissatisfied you may bring the matter to the Tribunal for Consumer Claims
          Malaysia, or contact the Ministry of Domestic Trade and Cost of Living. For a concern about
          how we have handled your personal data, contact our Data Protection Officer at{" "}
          {COMPANY.dpoEmail}, or the Personal Data Protection Department (JPDP).
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
