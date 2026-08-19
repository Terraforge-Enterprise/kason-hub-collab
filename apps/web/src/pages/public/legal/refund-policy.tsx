import LegalLayout, { LegalSection } from "./legal-layout";
import { COMPANY } from "@/lib/company-info";

/**
 * Return & Refund Policy.
 *
 * Publishing this is not optional: Fiuu ToS clause 3.9 provides that Fiuu's own
 * default refund policy binds the merchant where the merchant publishes none —
 * and that default is drafted for e-commerce goods, which would sit very badly
 * over security deposits governed by a tenancy agreement.
 *
 * The policy is deliberately split four ways, by what KAEN can actually verify
 * and actually pay:
 *
 *   A. Processing errors (duplicate, overpayment, debited-not-credited) — all
 *      provable from KAEN's own records plus the provider's transaction log, so
 *      KAEN refunds directly and fast.
 *   B. Unauthorised payments — NOT provable by KAEN alone. Needs the provider
 *      and the issuing bank, and the funds may be withheld during a chargeback
 *      investigation. Commits to an immediate hold and a fair process, not to a
 *      predetermined refund.
 *   C. Rent already applied and remitted to the owner — KAEN cannot unilaterally
 *      refund money it has paid away. Promising otherwise would be a commitment
 *      KAEN cannot fund out of its management fee.
 *   D. Security deposits — governed by the tenancy agreement. A blanket refund
 *      promise here would arguably override every deposit-deduction clause in
 *      every tenancy KAEN manages.
 *
 * Timelines track Fiuu's contractual windows: 14 days to resolve a customer
 * dispute (ToS cl. 8.6 note), 180 days maximum to raise one (cl. 8.5/8.6), and
 * refunds to the original payment method only (cl. 9.2).
 */
export default function RefundPolicyPage() {
  return (
    <LegalLayout
      title="Return & Refund Policy"
      intro="This policy explains when and how money paid through this website is refunded. Because we collect rent and other tenancy charges as agent for the property owner, different rules apply depending on what the payment was for. Please read the section that matches your situation."
    >
      <LegalSection title="What this policy covers">
        <p>
          This policy applies to payments made by tenants through our online workspace at{" "}
          {COMPANY.portalUrl.replace("https://", "")} using online banking (FPX), debit or credit
          card, or e-wallet.
        </p>
        <p>
          We do not sell physical goods, so no delivery, shipping or return of goods arises. Nothing
          in this policy limits your rights under the Consumer Protection Act 1999 or under your
          tenancy agreement.
        </p>
      </LegalSection>

      {/*
        Section A is limited to cases KAEN can settle from its OWN records and
        the payment provider's transaction log. An unauthorised-payment claim is
        deliberately NOT in this list — see section B.
      */}
      <LegalSection title="A. Payment and processing errors — refunded by us">
        <p>
          Once we have confirmed the position against our records and our payment
          provider&rsquo;s transaction log, we will refund you directly and in full where:
        </p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>You were charged twice</strong> for the same charge, or the same payment was
            captured more than once.
          </li>
          <li>
            <strong>Money left your account but the charge was not credited</strong> — for example
            an FPX payment was debited by your bank but did not complete, or the session timed out
            after your bank had already debited you.
          </li>
          <li>
            <strong>You paid more than the amount due</strong> and the excess has not been applied
            to another outstanding charge.
          </li>
          <li>
            <strong>You were billed in error</strong> — the charge was not yours, was a duplicate of
            another charge, or was raised against the wrong unit or tenancy.
          </li>
        </ul>
        <p>
          Where a charge was billed in error but you have other amounts outstanding, we will tell you
          the amount involved and you may choose either a refund or a credit applied to those
          outstanding charges.
        </p>
      </LegalSection>

      {/*
        MONEY GUARD — do not fold this back into section A.
        KAEN cannot verify a fraud claim on its own: it needs the payment
        provider and, for card payments, the issuing bank, whose investigation
        runs on its own timetable (Fiuu ToS cl. 8.5 allows settlement to be
        withheld up to 180 days pending a chargeback investigation — so the
        money may not even be in KAEN's hands). Promising an unconditional
        full refund on an unverified allegation both over-commits KAEN and
        invites first-party ("friendly") fraud. The commitment here is to act
        immediately and to a fair process, not to a predetermined outcome.
      */}
      <LegalSection title="B. Payments you did not authorise">
        <p>
          If you tell us a payment was not authorised by you, we treat it as urgent. We will
          acknowledge it within 1 business day, place a hold on any further collection against the
          charge concerned, and begin investigating immediately.
        </p>
        <p>
          <strong>We cannot promise a refund before the claim has been verified.</strong> An
          unauthorised-payment claim has to be checked with our payment provider and, where a card
          was used, with your bank or card issuer. Their investigation runs on its own timetable and
          the funds concerned may be held by the provider while it is under way.
        </p>
        <p>
          Once a payment is confirmed to have been unauthorised, we refund it in full to the original
          payment method, and you owe nothing in respect of it. If the claim is not upheld, we will
          tell you why and show you the transaction records we relied on, so that you can take it up
          with your bank if you disagree.
        </p>
        <p>
          <strong>Please also report it to your bank or card issuer, not only to us.</strong> They
          can block the card and start their own process, which we have no ability to do on your
          behalf, and acting quickly gives you the best chance of recovering the money.
        </p>
      </LegalSection>

      {/* Section B — the honest limit created by the agency model. */}
      <LegalSection title="C. Rent and tenancy charges already paid to the owner">
        <p>
          When you pay rent or another tenancy charge, that money belongs to the property owner. We
          apply it to your charge and remit it to the owner, less our management fee and any expenses
          we are authorised to pay on their behalf.
        </p>
        <p>
          Rent that has been correctly billed and correctly paid is not refundable simply on request,
          because it discharges a debt you owed under your tenancy agreement. Where you believe rent
          or a charge should be returned to you — for example the tenancy ended earlier than billed,
          or the property was not usable for part of the period — that is a matter under your tenancy
          agreement with the owner.
        </p>
        <p>
          <strong>We will act on it for you.</strong> Tell us and we will put the claim to the owner,
          give you our records of what was billed and collected, and process the refund or credit as
          soon as the owner agrees or the tenancy agreement clearly provides for it. Where funds have
          already been remitted to the owner, we may need to recover them from the owner before we
          can pay you, and we will keep you updated on progress.
        </p>
      </LegalSection>

      {/* Section C — carve-out. Without this, the policy overrides tenancy terms. */}
      <LegalSection title="D. Security deposits and utility deposits">
        <p>
          <strong>Deposits are not refunded under this policy.</strong> They are refunded under your
          tenancy agreement.
        </p>
        <p>
          Your tenancy agreement determines whether a deposit is refundable, what may be deducted
          from it — such as unpaid rent, unpaid utilities, or the cost of making good damage beyond
          fair wear and tear — and the period after handover within which the balance is returned.
          Nothing in this policy shortens, extends or overrides those terms.
        </p>
        <p>
          At the end of your tenancy we will provide a written account of any deductions, with
          supporting invoices or quotations, before the balance is released.
        </p>
      </LegalSection>

      <LegalSection title="How to request a refund">
        <p>
          Email {COMPANY.supportEmail} or call {COMPANY.phone} during business hours, and include:
        </p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>your name and the unit or property address;</li>
          <li>the date and amount of the payment;</li>
          <li>the receipt or payment reference from your account, if you have it;</li>
          <li>the bank or card used; and</li>
          <li>a short description of what went wrong.</li>
        </ul>
        <p>
          Please contact us as soon as you notice a problem. Requests relating to a payment made more
          than <strong>180 days</strong> ago may not be recoverable, because that is the outer limit
          within which our payment provider and the banks can trace and reverse a transaction.
        </p>
      </LegalSection>

      <LegalSection title="How long it takes">
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>Acknowledgement:</strong> within 2 business days of your request.
          </li>
          <li>
            <strong>Outcome:</strong> we aim to resolve disputed transactions within{" "}
            <strong>14 days</strong> of receiving the information we need. If a case is more complex
            — for example the bank must trace a failed FPX transfer — we will tell you and keep you
            updated.
          </li>
          <li>
            <strong>Money back:</strong> once approved, we submit the refund immediately. Funds
            typically reach you within 7 to 14 business days for cards and 3 to 7 business days for
            FPX, depending on your bank. The final timing is set by your bank or card issuer, not by
            us.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How refunds are paid">
        <p>
          Refunds are returned to the <strong>original payment method</strong> — the same bank
          account or card used to make the payment. This is a requirement of our payment provider and
          protects against fraud. We cannot refund to a different account, pay refunds in cash, or
          send a refund to a third party.
        </p>
        <p>
          If the original card has since expired or been cancelled, contact your bank first; where
          the bank cannot route the refund, we will agree an alternative with you and may ask for
          identification before releasing funds.
        </p>
        <p>
          Refunds are made in Malaysian Ringgit for the amount received. We do not charge a fee to
          process a refund. Where a payment was made from a foreign card, the amount you receive may
          differ slightly from the amount you paid because of exchange rate movement and your
          bank&rsquo;s charges — that difference is outside our control.
        </p>
      </LegalSection>

      <LegalSection title="If you are not satisfied">
        <p>
          If you disagree with our decision, ask for it to be escalated — see the{" "}
          <a href="/contact" className="text-[#B8963E] underline underline-offset-4">
            Contact Us
          </a>{" "}
          page for the escalation route. You may also raise the matter with your bank or card issuer,
          or bring a claim before the Tribunal for Consumer Claims Malaysia where your claim falls
          within its jurisdiction.
        </p>
        <p>
          We ask that you contact us before raising a chargeback with your bank. A chargeback is
          reversed by the bank without reference to our records and often takes considerably longer
          than dealing with us directly.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
