import { describe, it, expect } from "vitest";
import { buildVCard } from "../v-card";
import type { PublicCardDto } from "../types";

const baseCard: PublicCardDto = {
  displayName: "Kason Khoo",
  title: "Founder",
  primaryEmail: "kason@example.com",
  primaryPhone: "60123828967",
  whatsappPhone: "60123828967",
  org: {
    agencyName: "EUM Realty Sdn Bhd",
    agencyLicense: "E(1) 1708",
    agencyPhone: null,
    agencyFax: null,
    address: ["Line 1", "Line 2"],
    logoUrl: "/logo-gold.png",
  },
  listings: [],
  expiresAt: null,
};

describe("buildVCard sanitization (per spec §9.10)", () => {
  it("produces a valid v3.0 vCard with FN/TITLE/TEL/EMAIL/ORG", () => {
    const v = buildVCard(baseCard);
    expect(v).toContain("BEGIN:VCARD");
    expect(v).toContain("VERSION:3.0");
    expect(v).toContain("FN:Kason Khoo");
    expect(v).toContain("TITLE:Founder");
    expect(v).toContain("TEL;TYPE=cell:60123828967");
    expect(v).toContain("EMAIL:kason@example.com");
    expect(v).toContain("ORG:EUM Realty Sdn Bhd");
    expect(v).toContain("END:VCARD");
  });

  it("uses CRLF line endings (per RFC 6350)", () => {
    const v = buildVCard(baseCard);
    expect(v).toContain("\r\n");
    expect(v.split("\r\n").length).toBeGreaterThan(5);
  });

  it("strips CR/LF from displayName (prevents header-injection)", () => {
    const v = buildVCard({
      ...baseCard,
      displayName: "Kason\r\nBcc: attacker@x.com",
    });
    // Bcc text survives as a substring, but it can no longer create a
    // standalone vCard line — the CRLF that would split it is gone.
    expect(v).toContain("FN:KasonBcc: attacker@x.com");
    // Ensure the only CRLFs remaining are the genuine line separators
    // between known vCard fields, not anywhere inside FN.
    const fnLine = v
      .split("\r\n")
      .find((l) => l.startsWith("FN:"));
    expect(fnLine).toBe("FN:KasonBcc: attacker@x.com");
  });

  it("rejects leading formula chars on FN/TITLE/ORG", () => {
    const v = buildVCard({
      ...baseCard,
      displayName: "=cmd|attack",
      title: "+attack",
      org: { ...baseCard.org, agencyName: "@evil" },
    });
    expect(v).toContain("FN:cmd|attack");
    expect(v).toContain("TITLE:attack");
    expect(v).toContain("ORG:evil");
  });

  it("strips Unicode bidi-override characters from displayName", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) inserted between K and ason.
    const v = buildVCard({
      ...baseCard,
      displayName: "K‮ason",
    });
    expect(v).not.toMatch(/‮/);
    expect(v).toContain("FN:Kason");
  });

  it("omits FN line when displayName sanitizes to empty", () => {
    const v = buildVCard({ ...baseCard, displayName: "=" });
    expect(v).not.toMatch(/^FN:/m);
  });

  it("omits TEL/EMAIL/ORG lines when source values are null", () => {
    const v = buildVCard({
      ...baseCard,
      primaryPhone: null,
      primaryEmail: null,
      org: { ...baseCard.org, agencyName: null },
    });
    expect(v).not.toContain("TEL;");
    expect(v).not.toContain("EMAIL:");
    expect(v).not.toContain("ORG:");
    // Required envelope must still be present.
    expect(v).toContain("BEGIN:VCARD");
    expect(v).toContain("END:VCARD");
  });
});

describe("buildVCard phone normalization (Chunk F)", () => {
  it("renders canonical phone in TEL line unchanged", () => {
    const v = buildVCard({ ...baseCard, primaryPhone: "60123456789" });
    expect(v).toContain("TEL;TYPE=cell:60123456789");
  });

  it("normalizes legacy +60 phone to canonical in TEL line", () => {
    // Pre-Chunk-C snapshots may still carry the leading '+'. The vCard
    // output must not leak it.
    const v = buildVCard({ ...baseCard, primaryPhone: "+60123456789" });
    expect(v).toContain("TEL;TYPE=cell:60123456789");
    const telLine = v
      .split("\r\n")
      .find((l) => l.startsWith("TEL"));
    expect(telLine).toBe("TEL;TYPE=cell:60123456789");
  });

  it("normalizes legacy local-format (0XX-...) to canonical in TEL line", () => {
    const v = buildVCard({ ...baseCard, primaryPhone: "012-345 6789" });
    expect(v).toContain("TEL;TYPE=cell:60123456789");
  });

  it("omits TEL line when primaryPhone is null", () => {
    const v = buildVCard({ ...baseCard, primaryPhone: null });
    expect(v).not.toMatch(/^TEL/m);
  });

  it("omits TEL line when primaryPhone is unparseable garbage", () => {
    // readPhoneAnyFormat returns null for un-canonicalizable input;
    // the line is dropped rather than rendered with bad data.
    const v = buildVCard({ ...baseCard, primaryPhone: "not-a-phone" });
    expect(v).not.toMatch(/^TEL/m);
  });
});
