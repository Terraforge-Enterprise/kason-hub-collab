import LegalLayout, { LegalSection } from "./legal-layout";
import { COMPANY, COMPANY_LEGAL_LINE } from "@/lib/company-info";

export default function TermsPage() {
  return (
    <LegalLayout
      title="Terms & Conditions"
      intro={`These terms govern your use of the online workspace operated by ${COMPANY_LEGAL_LINE} ("KAEN", "we", "us") at ${COMPANY.portalUrl.replace("https://", "")}, including any payment you make through it. By using the workspace you agree to these terms.`}
    >
      {/*
        The tri-partite section is the one that matters most. Tenant money is
        collected as agent for the owner, so the terms must (a) disclose the
        agency, and (b) state that payment to KAEN discharges the tenant's
        obligation to the owner — without which a tenant who pays KAEN could in
        principle still be pursued by the owner for the same rent.
      */}
      <LegalSection title="1. Who you are contracting with">
        <p>
          The workspace is operated by KAEN. Access is provided to tenants of properties we manage,
          to the owners of those properties, and to our staff and appointed agents.
        </p>
        <p>
          <strong>For tenants:</strong> your tenancy is a contract between you and the property
          owner (your landlord), not with KAEN. KAEN manages the property and collects amounts due
          as the owner&rsquo;s authorised agent. These terms govern your use of the workspace and
          the payment facility only — they do not vary your tenancy agreement.
        </p>
        <p>
          <strong>For owners:</strong> your relationship with us is governed by the management
          agreement you have signed. These terms govern your use of the workspace only.
        </p>
        <p>
          <strong>Where these terms conflict with a signed tenancy agreement or management
          agreement, that signed agreement prevails.</strong>
        </p>
      </LegalSection>

      <LegalSection title="2. Your account">
        <p>
          Accounts are issued by us; you cannot self-register. You are responsible for keeping your
          password confidential and for activity carried out under your login. Tell us immediately
          at {COMPANY.supportEmail} if you believe your account has been accessed by someone else.
        </p>
        <p>
          You agree not to attempt to access data belonging to another tenant, owner or property, to
          interfere with the workspace, or to use it for any unlawful purpose. We may suspend access
          where we reasonably believe these terms have been breached, or where an account is being
          used in a way that puts other users&rsquo; data at risk.
        </p>
      </LegalSection>

      <LegalSection title="3. Charges and statements">
        <p>
          Charges shown in your account arise from your tenancy agreement and from utilities and
          services consumed. Each charge shows its description, amount, billing period and due date
          before you pay. All amounts are in Malaysian Ringgit (MYR) and are inclusive of any
          applicable Sales and Service Tax unless stated otherwise.
        </p>
        <p>
          We take care to bill accurately, but statements are not final. If a charge is later found
          to be wrong — for example a meter was misread, or a payment was recorded against the wrong
          charge — we may issue a credit note or debit note to correct it, and we will tell you when
          we do. If you think a charge is wrong, contact us before the due date and we will hold
          collection on the disputed amount while we look into it.
        </p>
      </LegalSection>

      <LegalSection title="4. Making a payment">
        <p>
          Payments are processed by {COMPANY.paymentProcessor}, a payment provider approved by Bank
          Negara Malaysia. We do not receive or store your full card number or your online banking
          credentials — those are entered on the provider&rsquo;s secure page.
        </p>
        <p>
          When you pay, you select the specific charges you are paying. Your payment is applied to
          those charges. A payment is complete when your bank or card issuer authorises it and the
          provider confirms it to us; only then is the charge marked paid and a receipt issued.
        </p>
        <p>
          If a payment is initiated but not confirmed — you closed the bank window, the session timed
          out, or the bank declined it — the charge stays unpaid. Do not assume a payment succeeded
          until the charge shows as paid in your account and you have a receipt. If money has left
          your account but the charge is still showing unpaid, contact us; see the{" "}
          <a href="/refund-policy" className="text-[#B8963E] underline underline-offset-4">
            Return &amp; Refund Policy
          </a>
          .
        </p>
        <p>
          Payment made to KAEN through this workspace discharges your obligation to the property
          owner to the extent of the amount paid and applied.
        </p>
      </LegalSection>

      <LegalSection title="5. Late payment">
        <p>
          Rent and other charges are due on the dates set out in your tenancy agreement. Late payment
          consequences — including any late payment interest, and the landlord&rsquo;s remedies — are
          governed by your tenancy agreement, not by these terms. We will contact you before taking
          any step on the owner&rsquo;s instructions.
        </p>
      </LegalSection>

      <LegalSection title="6. Security deposits">
        <p>
          Security deposits and utility deposits are held on the terms of your tenancy agreement.
          Whether a deposit is refundable, what may be deducted from it, and when it is returned are
          all determined by that agreement and by the condition of the property at handover — not by
          these terms and not by our refund policy.
        </p>
      </LegalSection>

      <LegalSection title="7. Documents and records">
        <p>
          Invoices, receipts, statements and tenancy documents are made available in your account.
          We keep them available to you for the duration of your tenancy and for a period afterwards
          in line with our retention practice described in the{" "}
          <a href="/privacy" className="text-[#B8963E] underline underline-offset-4">
            Privacy Policy
          </a>
          . Please download anything you need to keep.
        </p>
      </LegalSection>

      <LegalSection title="8. Availability">
        <p>
          We aim to keep the workspace available at all times but do not guarantee uninterrupted
          access. It may be unavailable during maintenance or because of a fault outside our control.
          Unavailability of the workspace does not postpone a payment due date under your tenancy
          agreement — contact us and we will arrange an alternative if you cannot pay online.
        </p>
      </LegalSection>

      <LegalSection title="9. Our liability">
        <p>
          Nothing in these terms limits liability that cannot lawfully be limited, including
          liability for fraud, or for death or personal injury caused by negligence. Your rights
          under the Consumer Protection Act 1999 are not affected.
        </p>
        <p>
          Subject to that, we are not liable for loss that was not reasonably foreseeable, for loss
          of profit or business opportunity, or for the acts or omissions of your landlord or of a
          third party such as a bank or utility provider. Our total liability arising from your use
          of the workspace is limited to the amount of management fees we received in respect of your
          tenancy in the twelve months before the claim arose.
        </p>
      </LegalSection>

      <LegalSection title="10. Changes to these terms">
        <p>
          We may update these terms from time to time. The version published here, with its stated
          update date, is the version that applies. Where a change materially affects you we will
          give notice through the workspace or by email before it takes effect.
        </p>
      </LegalSection>

      <LegalSection title="11. Complaints and governing law">
        <p>
          If something has gone wrong, please raise it with us first — the escalation route and our
          response times are on the{" "}
          <a href="/contact" className="text-[#B8963E] underline underline-offset-4">
            Contact Us
          </a>{" "}
          page. Most issues are resolved quickly once we can see the transaction.
        </p>
        <p>
          These terms are governed by the laws of Malaysia, and the courts of Malaysia have
          jurisdiction. Nothing here prevents you from bringing a claim before the Tribunal for
          Consumer Claims Malaysia where your claim falls within its jurisdiction.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
