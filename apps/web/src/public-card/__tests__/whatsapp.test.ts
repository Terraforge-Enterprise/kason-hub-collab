import { describe, it, expect } from "vitest";
import { buildWhatsAppLink } from "../whatsapp";

describe("buildWhatsAppLink (per spec §9.10)", () => {
  it("uses whatsappPhone when available", () => {
    const link = buildWhatsAppLink(
      "Kason",
      "60123828967",
      "012-3828967",
      "https://x.com/card/abc",
    );
    expect(link).toMatch(/^https:\/\/wa\.me\/60123828967\?text=/);
  });

  it("falls back to primaryPhone (canonicalized) when whatsappPhone is null", () => {
    // readPhoneAnyFormat strips the leading 0 — `012-3828967` becomes
    // `60123828967`. Without the canonicalization, wa.me/0123828967 is broken.
    const link = buildWhatsAppLink(
      "Kason",
      null,
      "012-3828967",
      "https://x.com/card/abc",
    );
    expect(link).toMatch(/^https:\/\/wa\.me\/60123828967\?/);
  });

  it("returns null when both phones are null", () => {
    expect(
      buildWhatsAppLink("Kason", null, null, "https://x.com/card/abc"),
    ).toBeNull();
  });

  it("returns null when phone is unparseable", () => {
    expect(
      buildWhatsAppLink("Kason", "()-+", null, "https://x.com/card/abc"),
    ).toBeNull();
  });

  it("URL-encodes the displayName in the text param", () => {
    const link = buildWhatsAppLink(
      "Tan Mei Lin",
      "60123828967",
      null,
      "https://x.com/card/abc",
    );
    expect(link).toContain(encodeURIComponent("Hi Tan Mei Lin"));
  });

  it("falls back to URL-only text when displayName fails the whitelist", () => {
    const link = buildWhatsAppLink(
      "Kason<script>",
      "60123828967",
      null,
      "https://x.com/card/abc",
    );
    expect(link).not.toContain("script");
    expect(link).toContain(encodeURIComponent("https://x.com/card/abc"));
  });

  it("accepts Unicode letters in the whitelist (e.g. CJK names)", () => {
    const link = buildWhatsAppLink(
      "陳美琳",
      "60123828967",
      null,
      "https://x.com/card/abc",
    );
    expect(link).toContain(encodeURIComponent("Hi 陳美琳"));
  });

  it("rejects names containing newlines or angle brackets", () => {
    const link = buildWhatsAppLink(
      "Kason\nBcc: x",
      "60123828967",
      null,
      "https://x.com/card/abc",
    );
    expect(link).not.toContain("Bcc");
    expect(link).toContain(encodeURIComponent("https://x.com/card/abc"));
  });
});

describe("buildWhatsAppLink with canonical phone", () => {
  it("uses canonical phone directly", () => {
    const url = buildWhatsAppLink(
      "Aiman",
      "60123456789",
      null,
      "https://example.com/card/abc",
    );
    expect(url).toContain("https://wa.me/60123456789");
  });

  it("normalizes legacy +60 stored value via readPhoneAnyFormat", () => {
    const url = buildWhatsAppLink(
      null,
      null,
      "+60123456789",
      "https://example.com/card/abc",
    );
    expect(url).toContain("https://wa.me/60123456789");
  });

  it("strips leading 0 from legacy local-format storage", () => {
    const url = buildWhatsAppLink(
      null,
      null,
      "012-345 6789",
      "https://example.com/card/abc",
    );
    expect(url).toContain("https://wa.me/60123456789");
  });

  it("returns null for unparseable phone", () => {
    const url = buildWhatsAppLink(null, "garbage", null, "https://example.com");
    expect(url).toBeNull();
  });
});
