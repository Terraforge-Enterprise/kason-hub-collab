/**
 * Single source of truth for the legal-entity details published on the public
 * compliance pages (/about, /terms, /privacy, /refund-policy, /contact).
 *
 * These details are published under the Consumer Protection (Electronic Trade
 * Transaction) Regulations 2024, which require disclosure of business name,
 * SSM registration number, address, email and telephone number, and under the
 * payment gateway's merchant terms.
 *
 * `legalName` and `registrationNumber` must match the entity named on the
 * payment-gateway merchant account and the settlement bank account.
 */

export const COMPANY = {
  /** Merchant of record. */
  legalName: "KAEN PROPERTIES MANAGEMENT SDN BHD",
  /** SSM registration number as displayed publicly. */
  registrationNumber: "1610050-V",
  /** Consumer-facing trading name. */
  tradingName: "KAEN Properties",

  registeredAddress: {
    line1: "No. 27-3, Jalan Perdana 10/12",
    line2: "Pandan Perdana",
    postcode: "55300",
    city: "Kuala Lumpur",
    country: "Malaysia",
  },

  supportEmail: "kaenproperties@gmail.com",
  /** PDPA (Amendment) Act 2024 s.12 — data controllers must appoint a DPO. */
  dpoEmail: "kaenproperties@gmail.com",
  phone: "011-3611 1763",
  /** E.164 form, for tel: links. */
  phoneE164: "+60113611763",
  whatsapp: "+60113611763",

  businessHours: "Monday – Friday, 9:00am – 6:00pm (MYT)",

  marketingSite: "https://kaenproperties.com",
  /** The domain where transactions occur. */
  portalUrl: "https://workspace.kaenproperties.com",

  /** Payment gateway / acquirer named in the privacy + refund disclosures. */
  paymentProcessor: "Fiuu (Razer Merchant Services Sdn Bhd)",

  /**
   * Business nature, as declared to the payment gateway. Rent, deposits,
   * utilities and related charges are collected from tenants as agent for the
   * property owner, then remitted to the owner net of management fees and
   * authorised expenses.
   */
  businessNature:
    "Property management services — collection of rent, security deposits, " +
    "utilities and related tenancy charges from tenants as authorised agent " +
    "for property owners, with periodic remittance to owners net of management " +
    "fees and authorised expenses.",

  /** Last review date shown on the legal pages. Bump when the copy changes. */
  policyLastUpdated: "12 August 2026",
} as const;

/** Single-line address, for inline prose and structured-data blocks. */
export const COMPANY_ADDRESS_ONELINE = [
  COMPANY.registeredAddress.line1,
  COMPANY.registeredAddress.line2,
  `${COMPANY.registeredAddress.postcode} ${COMPANY.registeredAddress.city}`,
  COMPANY.registeredAddress.country,
].join(", ");

/** "KAEN PROPERTIES MANAGEMENT SDN BHD (1610050-V)" — the CPETTR 2024 form. */
export const COMPANY_LEGAL_LINE = `${COMPANY.legalName} (${COMPANY.registrationNumber})`;
