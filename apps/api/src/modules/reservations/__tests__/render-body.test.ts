/**
 * Unit tests for buildReservationBodyHtml — pure function, no DB required.
 *
 * Run:
 *   npx vitest run apps/api/src/modules/reservations/__tests__/render-body.test.ts
 */
import { describe, it, expect } from "vitest";
import { buildReservationBodyHtml, TERMS_AND_CONDITIONS, type BodyInput } from "../render-body";

function makeInput(overrides: Partial<BodyInput> = {}): BodyInput {
  return {
    applicant: {
      fullName: "Jane Doe",
      nric: "901010-14-5678",
      contact: "012-3456789",
      email: "jane@example.com",
      addressLine1: "12, Jalan Bukit Bintang",
      addressLine2: "Taman Desa",
      city: "Kuala Lumpur",
      postcode: "55100",
      state: "Wilayah Persekutuan Kuala Lumpur",
      country: "Malaysia",
    },
    property: {
      name: "Test Property",
      unitCode: "A-01-02",
      carPark: null,
    },
    schedule: {
      moveIn: new Date("2026-06-01"),
      moveOut: null,
      remarks: null,
    },
    section1: {
      reservationDeposit: "500",
      documentationFee: "200",
    },
    section2: {
      rentalDeposit: "1500",
      utilityDeposit: "300",
      accessCardDeposit: "50",
    },
    ...overrides,
  };
}

/**
 * Extract all <li> elements from the rendered HTML as an array of strings,
 * in order of appearance.
 */
function extractListItems(html: string): string[] {
  const matches = html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? [];
  return matches;
}

describe("buildReservationBodyHtml", () => {
  it("renders all clauses normally when termsCustomization is omitted", () => {
    const html = buildReservationBodyHtml(makeInput());

    const items = extractListItems(html);

    // All 11 clauses must be present
    expect(items).toHaveLength(TERMS_AND_CONDITIONS.length);

    // None should have line-through style
    expect(html).not.toContain("line-through");
    expect(html).not.toContain("(removed by agent)");
    expect(html).not.toContain("Additional Terms");

    // Each item must be a plain <li> (no inline style attribute)
    for (const item of items) {
      expect(item).toMatch(/^<li>/);
      expect(item).not.toContain('style=');
    }
  });

  it("renders bundled defaults verbatim when customTerms is empty", () => {
    const html = buildReservationBodyHtml(
      makeInput({ termsCustomization: { customTerms: [] } }),
    );
    const items = extractListItems(html);
    expect(items).toHaveLength(TERMS_AND_CONDITIONS.length);
    // Defaults are HTML-escaped on render — clause 5 contains "&" → "&amp;".
    // Compare on the escaped form so the assertion stays true to the renderer.
    items.forEach((li, i) => {
      const expected = TERMS_AND_CONDITIONS[i].replace(/&/g, "&amp;");
      expect(li).toContain(expected);
    });
  });

  it("renders the customTerms list verbatim and ignores defaults when non-empty", () => {
    const custom = ["First custom clause.", "Second custom clause."];
    const html = buildReservationBodyHtml(
      makeInput({ termsCustomization: { customTerms: custom } }),
    );
    const items = extractListItems(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("First custom clause.");
    expect(items[1]).toContain("Second custom clause.");
    // No default clauses bleed through
    expect(html).not.toContain(TERMS_AND_CONDITIONS[0]);
  });

  it("HTML-escapes user-provided clauses to prevent XSS", () => {
    const html = buildReservationBodyHtml(
      makeInput({
        termsCustomization: { customTerms: ["<script>alert('xss')</script>"] },
      }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("renders fillable placeholder lines when applicant fields are empty (unsigned preview)", () => {
    const html = buildReservationBodyHtml(
      makeInput({
        applicant: {
          fullName: "", nric: "", contact: "", email: "",
          addressLine1: "", addressLine2: undefined, city: "", postcode: "", state: "", country: "",
        },
      }),
    );
    // Nine underscored placeholder lines: 4 identity + 5 required address
    // (addressLine2 is optional and renders no placeholder).
    const matches = html.match(/______________________________/g) ?? [];
    expect(matches.length).toBe(9);
  });

  it("escapes address fields in text context (no live tag) — spec R7", () => {
    const html = buildReservationBodyHtml(
      makeInput({
        applicant: {
          fullName: "Jane Doe",
          nric: "x",
          contact: "x",
          email: "j@x.com",
          addressLine1: 'x<img src="http://169.254.169.254/" onerror="fetch(1)">',
          addressLine2: undefined,
          city: "KL",
          postcode: "55100",
          state: "Selangor",
          country: "Malaysia",
        },
      }),
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src="http://169.254.169.254/"');
  });

  it("renders dates in Asia/Kuala_Lumpur regardless of host timezone", () => {
    // Midnight KL = previous day 16:00 UTC. The signed-PDF date must show
    // the KL calendar day the agent picked, not the UTC calendar day.
    // Intl.DateTimeFormat("en-MY", { day: "numeric", month: "numeric" })
    // returns zero-padded DD/MM/YYYY — the day-number (01 → June 1) is the
    // bug-locking assertion.
    const html = buildReservationBodyHtml(
      makeInput({
        schedule: { moveIn: new Date("2026-05-31T16:00:00.000Z"), moveOut: null, remarks: null },
      }),
    );
    expect(html).toContain(">Proposed Move In:</strong> 01/06/2026<");
  });

  it("T&C section carries page-break-before:always so it lands on its own page", () => {
    const html = buildReservationBodyHtml(makeInput());
    expect(html).toMatch(/<section class="tnc-section"><h3>Terms & Conditions<\/h3>/);
  });
});
