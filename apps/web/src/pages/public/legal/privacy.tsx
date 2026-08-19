import LegalLayout, { LegalSection } from "./legal-layout";
import { COMPANY, COMPANY_ADDRESS_ONELINE, COMPANY_LEGAL_LINE } from "@/lib/company-info";

/**
 * Privacy Policy — the PDPA 2010 s.7 Notice & Choice notice.
 *
 * Shaped to the Personal Data Protection Act 2010 as amended by the Personal
 * Data Protection (Amendment) Act 2024, whose main obligations took effect
 * 1 June 2025: mandatory DPO appointment (s.12B), breach notification to the
 * Commissioner and to affected data subjects (s.12B), data processors directly
 * liable for the Security Principle, and the new right to data portability.
 *
 * Two disclosures here are load-bearing for KAEN's specific model and must not
 * be dropped in a future edit:
 *
 *   1. Disclosure of tenant personal data TO PROPERTY OWNERS. KAEN collects as
 *      agent and reports to owners, so owners receive tenant data. Under the
 *      Notice & Choice Principle that class of recipient must be named, or the
 *      disclosure is unlawful however routine it feels.
 *   2. Disclosure to the payment provider, who is a separate data controller
 *      for the card/banking data entered on its own hosted page.
 */
export default function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      intro={`${COMPANY_LEGAL_LINE} respects your privacy. This notice explains what personal data we collect, why we collect it, who we share it with, and the rights you have. It is issued under the Personal Data Protection Act 2010 as amended.`}
    >
      <LegalSection title="Who is responsible for your data">
        <p>
          {COMPANY.legalName} ({COMPANY.registrationNumber}) of {COMPANY_ADDRESS_ONELINE} is the data
          controller for the personal data described here.
        </p>
        <p>
          Our Data Protection Officer can be reached at{" "}
          <a
            href={`mailto:${COMPANY.dpoEmail}`}
            className="text-[#B8963E] underline underline-offset-4"
          >
            {COMPANY.dpoEmail}
          </a>{" "}
          or {COMPANY.phone}.
        </p>
      </LegalSection>

      <LegalSection title="What we collect">
        <p>Depending on your relationship with us, we may collect:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>Identity data</strong> — full name, NRIC or passport number, nationality, date of
            birth, and a copy of your identification document where required for tenancy
            documentation and stamping.
          </li>
          <li>
            <strong>Contact data</strong> — address, email address, telephone number, and emergency
            contact details.
          </li>
          <li>
            <strong>Tenancy data</strong> — tenancy agreements, unit and property details, occupancy
            dates, meter readings, condition reports, maintenance requests and correspondence.
          </li>
          <li>
            <strong>Financial data</strong> — charges raised, payments made, receipts, deposits held,
            outstanding balances, and bank account details where you receive a payout or refund from
            us.
          </li>
          <li>
            <strong>Employment or income information</strong> — where required by an owner as part of
            tenant screening.
          </li>
          <li>
            <strong>Technical data</strong> — login records, IP address, device and browser
            information, and pages accessed, kept for security and audit purposes.
          </li>
        </ul>
        <p>
          <strong>We do not collect or store your full card number, card security code, or online
          banking username and password.</strong> Those are entered directly on the secure page of
          our payment provider and never reach our systems.
        </p>
      </LegalSection>

      <LegalSection title="Where we get it from">
        <p>
          Most personal data comes from you directly — through enquiry and reservation forms, tenancy
          documentation, and your use of the workspace. We may also receive data about you from the
          property owner, from a property agent who introduced you, from your employer or a previous
          landlord where you have given a reference, and from our payment provider in the form of
          transaction confirmations.
        </p>
      </LegalSection>

      <LegalSection title="Why we use it">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>to assess a tenancy application and prepare tenancy documentation;</li>
          <li>to manage the tenancy, including maintenance, inspections and renewals;</li>
          <li>to raise charges, collect payment, issue receipts and handle refunds;</li>
          <li>to account and report to the property owner, and to remit money due to them;</li>
          <li>to provide you with access to your account, documents and statements;</li>
          <li>to contact you about your tenancy, payments and the property;</li>
          <li>
            to comply with legal obligations, including stamping, tax and accounting records, and
            anti-money-laundering checks where they apply; and
          </li>
          <li>to detect and prevent fraud, and to protect the security of our systems.</li>
        </ul>
        <p>
          We do not sell your personal data, and we do not use it for third-party marketing.
        </p>
      </LegalSection>

      <LegalSection title="Who we share it with">
        <p>We disclose personal data only to the following, and only as far as necessary:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>The owner of the property you occupy.</strong> We manage the property as the
            owner&rsquo;s agent and account to them. Owners receive tenancy and payment information
            relating to their own property, including your name, tenancy terms, charges raised and
            amounts paid.
          </li>
          <li>
            <strong>Our payment provider, {COMPANY.paymentProcessor}</strong>, and the banks and card
            schemes involved in processing your payment. The provider handles your card and banking
            details as a controller in its own right, under its own privacy policy.
          </li>
          <li>
            <strong>Service providers acting for us</strong> — contractors and tradespeople attending
            maintenance, cleaning companies, utility providers, and our IT and cloud hosting
            providers.
          </li>
          <li>
            <strong>Professional advisers</strong> — lawyers, accountants and auditors, where needed.
          </li>
          <li>
            <strong>Government authorities</strong> — including the Inland Revenue Board for stamping
            and tax, and any authority we are legally required to disclose to.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Where your data is held">
        <p>
          Our systems are hosted on cloud infrastructure located in Singapore, and some of our
          service providers process data outside Malaysia. Where personal data is transferred out of
          Malaysia we take reasonable steps to ensure it receives a comparable level of protection,
          consistent with the Personal Data Protection Commissioner&rsquo;s guidelines on cross-border
          transfer.
        </p>
      </LegalSection>

      <LegalSection title="How we protect it">
        <p>
          Access to the workspace requires a password, and users can see only the properties and
          tenancies they are entitled to see. Data is encrypted in transit. Access by our staff is
          restricted by role and is logged.
        </p>
        <p>
          If a data breach occurs that causes or is likely to cause significant harm to you, we will
          notify the Personal Data Protection Commissioner and inform you, as required by the Act.
        </p>
      </LegalSection>

      <LegalSection title="How long we keep it">
        <p>
          We keep tenancy and financial records for at least seven years after the tenancy ends, to
          meet tax, accounting and limitation-period requirements. Identification documents are kept
          only for as long as needed for the tenancy and its stamping, and are then deleted. Records
          no longer needed for any of the purposes above are securely destroyed.
        </p>
      </LegalSection>

      <LegalSection title="Your rights">
        <p>Under the Act you may:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>ask for a copy of the personal data we hold about you;</li>
          <li>ask us to correct data that is inaccurate, incomplete or out of date;</li>
          <li>ask us to limit how we process your data;</li>
          <li>withdraw a consent you have given us; and</li>
          <li>
            ask us to transmit your data to another data controller, where it is technically feasible
            to do so.
          </li>
        </ul>
        <p>
          Write to {COMPANY.dpoEmail} to exercise any of these. We will respond within the period
          required by the Act. A fee may apply to a data access request. Note that some data must be
          retained regardless of a withdrawal of consent — for example accounting records we are
          legally required to keep — and that withdrawing consent for data needed to manage your
          tenancy may mean we cannot continue to provide the service.
        </p>
      </LegalSection>

      <LegalSection title="Supplying your data is sometimes obligatory">
        <p>
          Some data must be supplied before we can act — we cannot prepare or stamp a tenancy
          agreement without your name and identification details, and we cannot collect payment
          without a payment instrument. Where data is optional we will say so at the point we ask for
          it.
        </p>
      </LegalSection>

      <LegalSection title="Cookies">
        <p>
          The workspace uses cookies and similar browser storage strictly to keep you signed in and
          to remember display preferences. We do not use advertising or third-party tracking cookies.
        </p>
      </LegalSection>

      <LegalSection title="Changes and language">
        <p>
          We may update this notice; the version published here with its update date is the version
          that applies. This notice is issued in English and Bahasa Malaysia. A Bahasa Malaysia
          version is available on request from {COMPANY.supportEmail}. In the event of any
          inconsistency between the two versions, the English version prevails.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
