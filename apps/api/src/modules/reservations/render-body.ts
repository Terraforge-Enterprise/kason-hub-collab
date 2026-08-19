function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(date);
}

function money(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return `RM ${s}`;
  return `RM ${n.toFixed(2)}`;
}

function sum(...parts: string[]): string {
  const total = parts.reduce((acc, s) => acc + (Number(s) || 0), 0);
  return total.toFixed(2);
}

// Client mirror: apps/web/src/lib/reservation-terms.ts — must be kept identical.
// These are the bundled defaults rendered when a reservation has no
// customTerms list. When customTerms is non-empty, those replace this list
// verbatim and the indexes here have no meaning.
export const TERMS_AND_CONDITIONS: string[] = [
  "This form is for reservation and occupancy application purposes only.",
  "This form does not constitute a formal tenancy agreement, lease agreement, or transfer of legal property rights.",
  "Any formal occupancy or tenancy documentation (if required) shall be handled separately between relevant parties.",
  "Submission of this form is subject to owner / management approval and verification.",
  "Reservation Deposit and Documentation & Processing Fee paid are strictly non-refundable once confirmation and signing have been completed.",
  "In the event the applicant cancels, withdraws, changes mind, delays payment, fails to proceed, or breaches any stated condition, all amounts paid shall be forfeited.",
  "Rental Deposit, Utility Deposit and Access Card Deposit shall be payable prior to move in.",
  "Reservation is only valid within the stated confirmation and payment timeline.",
  "Applicant confirms that all submitted information is accurate and complete.",
  "Management reserves the right to reject or cancel the application if false or misleading information is provided.",
  "By signing this form, the applicant acknowledges and agrees to all terms and conditions stated above.",
];

export type BodyInput = {
  applicant: {
    fullName: string;
    nric: string;
    contact: string;
    email: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    postcode: string;
    state: string;
    country: string;
    nationality?: string | null;
    occupation?: string | null;
    monthlyIncome?: string | null;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
    emergencyContactRelation?: string | null;
  };
  property: { name: string; unitCode: string; carPark: string | null };
  schedule: { moveIn: Date; moveOut: Date | null; remarks: string | null };
  section1: { reservationDeposit: string; documentationFee: string };
  section2: { rentalDeposit: string; utilityDeposit: string; accessCardDeposit: string };
  termsCustomization?: {
    customTerms: string[];
  };
  documentsProvided?: { passport: boolean; ic: boolean };
};

export function buildReservationBodyHtml(input: BodyInput): string {
  const customTerms = input.termsCustomization?.customTerms ?? [];
  // Non-empty customTerms = the agent customised the list; render it verbatim
  // (numbering is derived by the <ol> automatically). Empty = bundled defaults.
  const finalClauses = customTerms.length > 0 ? customTerms : TERMS_AND_CONDITIONS;

  const termsSection = [
    `<section class="tnc-section"><h3>Terms & Conditions</h3><ol>`,
    ...finalClauses.map((t) => `<li>${esc(t)}</li>`),
    `</ol>`,
    `</section>`,
  ];

  return [
    `<section><h3>Applicant Information</h3>`,
    `<p><strong>Full Name:</strong> ${esc(input.applicant.fullName) || "______________________________"}</p>`,
    `<p><strong>NRIC / Passport:</strong> ${esc(input.applicant.nric) || "______________________________"}</p>`,
    `<p><strong>Contact:</strong> ${esc(input.applicant.contact) || "______________________________"}</p>`,
    `<p><strong>Email:</strong> ${esc(input.applicant.email) || "______________________________"}</p>`,
    `<p><strong>Address Line 1:</strong> ${esc(input.applicant.addressLine1) || "______________________________"}</p>`,
    ...(input.applicant.addressLine2
      ? [`<p><strong>Address Line 2:</strong> ${esc(input.applicant.addressLine2)}</p>`]
      : []),
    `<p><strong>City:</strong> ${esc(input.applicant.city) || "______________________________"}</p>`,
    `<p><strong>Postcode:</strong> ${esc(input.applicant.postcode) || "______________________________"}</p>`,
    `<p><strong>State:</strong> ${esc(input.applicant.state) || "______________________________"}</p>`,
    `<p><strong>Country:</strong> ${esc(input.applicant.country) || "______________________________"}</p>`,
    `<p><strong>Nationality:</strong> ${esc(input.applicant.nationality) || "—"}</p>`,
    `<p><strong>Occupation:</strong> ${esc(input.applicant.occupation) || "—"}</p>`,
    `<p><strong>Monthly Income:</strong> ${input.applicant.monthlyIncome ? money(input.applicant.monthlyIncome) : "—"}</p>`,
    `<p><strong>Emergency Contact:</strong> ${esc(input.applicant.emergencyContactName) || "—"}${input.applicant.emergencyContactPhone ? " — " + esc(input.applicant.emergencyContactPhone) : ""}${input.applicant.emergencyContactRelation ? " (" + esc(input.applicant.emergencyContactRelation) + ")" : ""}</p>`,
    `<p><strong>Identity documents provided:</strong> ${
      input.documentsProvided
        ? [input.documentsProvided.passport ? "Passport ✓" : null, input.documentsProvided.ic ? "IC ✓" : null].filter(Boolean).join(" / ") || "—"
        : "—"
    }</p>`,
    `</section>`,

    `<section><h3>Property Information</h3>`,
    `<p><strong>Property:</strong> ${esc(input.property.name)}</p>`,
    `<p><strong>Unit:</strong> ${esc(input.property.unitCode)}</p>`,
    `<p><strong>Car Park:</strong> ${esc(input.property.carPark) || "—"}</p>`,
    `<p><strong>Proposed Move In:</strong> ${fmt(input.schedule.moveIn)}</p>`,
    `<p><strong>Proposed Move Out:</strong> ${fmt(input.schedule.moveOut)}</p>`,
    `<p><strong>Remarks:</strong> ${esc(input.schedule.remarks) || "—"}</p>`,
    `</section>`,

    `<section><h3>Section 1 — Reservation & Administrative Charges</h3>`,
    `<table class="fee-table"><tbody>`,
    `<tr><td>Reservation Deposit</td><td>${money(input.section1.reservationDeposit)}</td></tr>`,
    `<tr><td>Documentation &amp; Processing Fee</td><td>${money(input.section1.documentationFee)}</td></tr>`,
    `</tbody></table>`,
    `</section>`,

    `<section><h3>Section 2 — Move-In Related Deposits</h3>`,
    `<table class="fee-table"><tbody>`,
    `<tr><td>Rental Deposit</td><td>${money(input.section2.rentalDeposit)}</td></tr>`,
    `<tr><td>Utility Deposit</td><td>${money(input.section2.utilityDeposit)}</td></tr>`,
    `<tr><td>Access Card Deposit</td><td>${money(input.section2.accessCardDeposit)}</td></tr>`,
    `</tbody></table>`,
    `<div class="fee-total"><span>Total Payable</span><span class="amount">${money(
      sum(
        input.section1.reservationDeposit,
        input.section1.documentationFee,
        input.section2.rentalDeposit,
        input.section2.utilityDeposit,
        input.section2.accessCardDeposit,
      ),
    )}</span></div>`,
    `</section>`,

    ...termsSection,
  ].join("\n");
}
