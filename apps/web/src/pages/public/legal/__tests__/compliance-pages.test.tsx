import { describe, it, expect } from "vitest";
import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

import AboutPage from "../about";
import TermsPage from "../terms";
import PrivacyPage from "../privacy";
import RefundPolicyPage from "../refund-policy";
import ContactPage from "../contact";
import { COMPANY, COMPANY_LEGAL_LINE } from "@/lib/company-info";

/**
 * These pages exist to satisfy two external obligations, and both are silent
 * failure modes — nothing crashes when they regress, the merchant application
 * just gets rejected or the company sits in breach of the Consumer Protection
 * Act. So the invariants are pinned here rather than left to review.
 *
 *   1. Fiuu (Razer Merchant Services) ToS cl. 3.9 — trading name, address,
 *      telephone, URL, what is being paid for, and a published refund policy.
 *   2. Consumer Protection (Electronic Trade Transaction) Regulations 2024 —
 *      business name, SSM registration number, address, email and phone.
 */

const PAGES = [
  { name: "About Us", Component: AboutPage },
  { name: "Terms & Conditions", Component: TermsPage },
  { name: "Privacy Policy", Component: PrivacyPage },
  { name: "Return & Refund Policy", Component: RefundPolicyPage },
  { name: "Contact Us", Component: ContactPage },
] as const;

function renderPage(Component: () => ReactElement) {
  return render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}

describe("public compliance pages", () => {
  /**
   * The load-bearing test. These pages take no auth context, no API client and
   * no query provider — a reviewer who cannot log in must still see them. If a
   * future edit introduces a hook that needs a session or a fetch, this render
   * throws and the regression is caught here rather than by Fiuu.
   */
  describe.each(PAGES)("$name", ({ Component }) => {
    it("renders with no session, no API and no query provider", () => {
      expect(() => renderPage(Component)).not.toThrow();
    });

    it("publishes the CPETTR 2024 disclosure block", () => {
      const { container } = renderPage(Component);
      const text = container.textContent ?? "";

      // Business name + SSM registration number, in the "NAME (NO)" form.
      expect(text).toContain(COMPANY_LEGAL_LINE);
      expect(text).toContain(COMPANY.registrationNumber);
      // Address, email and telephone.
      expect(text).toContain(COMPANY.registeredAddress.line1);
      expect(text).toContain(COMPANY.registeredAddress.postcode);
      expect(text).toContain(COMPANY.supportEmail);
      expect(text).toContain(COMPANY.phone);
    });

    it("cross-links all five compliance pages", () => {
      const { container } = renderPage(Component);
      const nav = within(container).getAllByRole("navigation", {
        name: /legal and company information/i,
      })[0];

      for (const href of ["/about", "/terms", "/privacy", "/refund-policy", "/contact"]) {
        expect(
          within(nav).getByRole("link", {
            name: new RegExp(href.replace("/", "").replace("-", ".?"), "i"),
          }),
        ).toHaveAttribute("href", href);
      }
    });
  });
});

describe("Return & Refund Policy — money-safety carve-outs", () => {
  /**
   * MONEY GUARD. KAEN collects rent as agent for the owner and remits it. A
   * refund policy that promised unconditional refunds would commit KAEN to
   * repaying money it has already paid away, out of its management fee.
   * Section B must keep saying that correctly-billed rent is not refundable on
   * request.
   */
  it("does not promise unconditional refunds of correctly-billed rent", () => {
    const { container } = renderPage(RefundPolicyPage);
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).toContain("not refundable simply on request");
    expect(text).toContain("as agent");
  });

  /**
   * MONEY GUARD. Deposits are governed by the tenancy agreement. Without this
   * carve-out the published policy would arguably override every deposit
   * deduction clause in every tenancy KAEN manages — a far more expensive
   * mistake than publishing nothing at all.
   */
  it("carves security deposits out to the tenancy agreement", () => {
    const { container } = renderPage(RefundPolicyPage);
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).toContain("deposits are not refunded under this policy");
    expect(text).toContain("tenancy agreement");
  });

  /**
   * MONEY GUARD. An unauthorised-payment claim cannot be verified by KAEN
   * alone — it needs the payment provider and the issuing bank, and Fiuu ToS
   * cl. 8.5 lets settlement be withheld up to 180 days during a chargeback
   * investigation, so the money may not even be in KAEN's hands. An
   * unconditional "we will refund you in full" both over-commits KAEN and
   * invites first-party fraud. The page must promise process, not outcome.
   */
  it("does not promise an unconditional refund for unauthorised payments", () => {
    const { container } = renderPage(RefundPolicyPage);
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).toContain("we cannot promise a refund before the claim has been verified");
    // The refund is conditional on confirmation, never on the allegation alone.
    expect(text).toContain("once a payment is confirmed to have been unauthorised");
    // ...but the process commitment is still concrete and consumer-fair.
    expect(text).toContain("place a hold on any further collection");
  });

  /**
   * The section A list must stay limited to what KAEN can prove from its own
   * records. If "unauthorised" is ever folded back into that list, the
   * unconditional promise returns through the back door.
   */
  it("keeps unauthorised payments out of the refunded-directly list", () => {
    const { container } = renderPage(RefundPolicyPage);
    const text = container.textContent ?? "";

    const listIntro = text.indexOf("we will refund you directly and in full where");
    const sectionB = text.indexOf("B. Payments you did not authorise");
    expect(listIntro).toBeGreaterThan(-1);
    expect(sectionB).toBeGreaterThan(listIntro);

    // Nothing between the section A intro and section B may allege fraud.
    expect(text.slice(listIntro, sectionB).toLowerCase()).not.toContain("unauthorised");
  });

  /** Section A refunds are conditional on verification, not on the request. */
  it("conditions section A refunds on confirmation against records", () => {
    const { container } = renderPage(RefundPolicyPage);
    expect((container.textContent ?? "").toLowerCase()).toContain(
      "once we have confirmed the position against our records",
    );
  });

  /**
   * Fiuu ToS cl. 9.2 — refunds go to the original payment method only. Stating
   * a different route on the website would contradict what the gateway can
   * actually do.
   */
  it("states refunds return to the original payment method", () => {
    const { container } = renderPage(RefundPolicyPage);
    expect((container.textContent ?? "").toLowerCase()).toContain("original payment method");
  });
});

describe("Terms — agency disclosure", () => {
  /**
   * Tenants pay KAEN, not the owner. Without an express statement that payment
   * to KAEN discharges the tenant's obligation, a tenant who has paid could in
   * principle still be pursued by the owner for the same rent.
   */
  it("states that paying KAEN discharges the tenant's obligation to the owner", () => {
    const { container } = renderPage(TermsPage);
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).toContain("discharges your obligation to the property owner");
  });

  it("subordinates itself to the signed tenancy agreement", () => {
    const { container } = renderPage(TermsPage);
    expect((container.textContent ?? "").toLowerCase()).toContain("that signed agreement prevails");
  });
});

describe("Privacy Policy — PDPA disclosures", () => {
  /**
   * KAEN discloses tenant personal data to property owners as part of its
   * agency reporting. Under the PDPA Notice & Choice Principle that class of
   * recipient must be named, however routine the disclosure feels.
   */
  it("names property owners as recipients of tenant personal data", () => {
    const { container } = renderPage(PrivacyPage);
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).toContain("the owner of the property you occupy");
  });

  it("names the payment provider as a recipient", () => {
    const { container } = renderPage(PrivacyPage);
    expect(container.textContent ?? "").toContain(COMPANY.paymentProcessor);
  });

  /** PDPA (Amendment) Act 2024 — DPO contact must be published. */
  it("publishes a Data Protection Officer contact", () => {
    const { container } = renderPage(PrivacyPage);
    const text = container.textContent ?? "";

    expect(text).toContain("Data Protection Officer");
    expect(text).toContain(COMPANY.dpoEmail);
  });

  /** The card-data boundary is a factual claim; keep it accurate and present. */
  it("states that full card and banking credentials are never stored", () => {
    const { container } = renderPage(PrivacyPage);
    expect((container.textContent ?? "").toLowerCase()).toContain(
      "we do not collect or store your full card number",
    );
  });
});

describe("About Us — Fiuu clause 3.9 'what is being sold'", () => {
  it("explains that tenants are not buying goods and that KAEN collects as agent", () => {
    const { container } = renderPage(AboutPage);
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).toContain("as the authorised agent of the property owner");
    expect(text).toContain("not");
  });

  it("names the point at which a payment is complete", () => {
    const { container } = renderPage(AboutPage);
    expect((container.textContent ?? "").toLowerCase()).toContain("a payment is complete when");
  });
});
