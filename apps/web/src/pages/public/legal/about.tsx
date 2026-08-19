import LegalLayout, { LegalSection } from "./legal-layout";
import { COMPANY, COMPANY_ADDRESS_ONELINE, COMPANY_LEGAL_LINE } from "@/lib/company-info";

export default function AboutPage() {
  return (
    <LegalLayout
      title="About Us"
      intro={`${COMPANY_LEGAL_LINE} is a property management company based in Kuala Lumpur, Malaysia. We manage residential and investment properties on behalf of their owners, and operate the online workspace where tenants and owners view their statements and settle amounts due.`}
    >
      <LegalSection title="Who we are">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-4 sm:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <div>
            <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
              Registered company name
            </dt>
            <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">{COMPANY.legalName}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
              Company registration number
            </dt>
            <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">
              {COMPANY.registrationNumber}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
              Registered address
            </dt>
            <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">{COMPANY_ADDRESS_ONELINE}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-500">Business hours</dt>
            <dd className="mt-0.5 text-zinc-800 dark:text-zinc-200">{COMPANY.businessHours}</dd>
          </div>
        </dl>
      </LegalSection>

      <LegalSection title="What we do">
        <p>
          We provide end-to-end property management for owners who would rather not run their
          properties themselves. Our services include tenant sourcing and screening, tenancy
          documentation, rent and utility collection, maintenance coordination, renovation
          management, and monthly financial reporting to owners.
        </p>
        <p>
          Our client is the property owner. We are engaged by owners under a management agreement
          to manage their properties, and we are remunerated by a management fee agreed with each
          owner.
        </p>
      </LegalSection>

      {/*
        Fiuu ToS clause 3.9 requires the website to describe "what goods and
        services are being offered for sale ... and the point at which a sale is
        completed". For an agency collection model the honest answer is that
        nothing is sold to the tenant — this section says so plainly, and is the
        section a gateway reviewer will look for.
      */}
      <LegalSection title="How payments through this website work">
        <p>
          Amounts paid by tenants through this website are <strong>not</strong> purchases of goods
          from us. Tenants pay rent, security deposits, utilities and other charges arising under
          their tenancy agreement, and we collect those amounts{" "}
          <strong>as the authorised agent of the property owner</strong>.
        </p>
        <p>
          Money received is applied to the charges the tenant has selected. We then remit the
          balance to the property owner on a periodic basis, after deducting our management fee and
          any expenses we are authorised to pay on the owner&rsquo;s behalf, such as utilities,
          repairs and cleaning.
        </p>
        <p>
          A payment is complete when it is authorised by the tenant&rsquo;s bank or card issuer and
          confirmed to us by our payment provider, {COMPANY.paymentProcessor}. At that point the
          charge is marked as paid in the tenant&rsquo;s account and a receipt is issued. Paying us
          discharges the tenant&rsquo;s obligation to the owner to the extent of the amount paid.
        </p>
      </LegalSection>

      <LegalSection title="Where we operate">
        <p>
          We operate in Kuala Lumpur and the surrounding Klang Valley. All amounts on this website
          are stated in Malaysian Ringgit (MYR). Payments are accepted through Malaysian online
          banking (FPX), debit and credit cards, and supported e-wallets.
        </p>
      </LegalSection>

      <LegalSection title="Get in touch">
        <p>
          Our full contact details, response times and complaint escalation route are on the{" "}
          <a href="/contact" className="text-[#B8963E] underline underline-offset-4">
            Contact Us
          </a>{" "}
          page. You can also visit our main website at{" "}
          <a
            href={COMPANY.marketingSite}
            className="text-[#B8963E] underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            {COMPANY.marketingSite.replace("https://", "")}
          </a>
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
