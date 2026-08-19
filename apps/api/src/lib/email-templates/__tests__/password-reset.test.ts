import { describe, it, expect } from "vitest";
import { passwordResetEmail } from "../password-reset";

describe("passwordResetEmail", () => {
  it("returns subject, html, and text for admin surface", () => {
    const out = passwordResetEmail({
      surface: "admin",
      fullName: "Alice Tan",
      resetUrl: "https://admin.example.com/reset-password?token=abc",
    });
    expect(out.subject).toBe("Reset your Kason-Hub password");
    expect(out.html).toContain("Hi Alice Tan,");
    expect(out.html).toContain("admin password");
    expect(out.html).toContain("https://admin.example.com/reset-password?token=abc");
    expect(out.text).toContain("Hi Alice Tan,");
    expect(out.text).toContain("https://admin.example.com/reset-password?token=abc");
  });

  it("returns portal copy for portal surface", () => {
    const out = passwordResetEmail({
      surface: "portal",
      fullName: "Bob Lee",
      resetUrl: "https://portal.example.com/portal/reset-password?token=xyz",
    });
    expect(out.html).toContain("agent password");
    expect(out.html).toContain("Hi Bob Lee,");
  });

  it("HTML-escapes fullName to prevent injection", () => {
    const out = passwordResetEmail({
      surface: "admin",
      fullName: '<script>alert("xss")</script>',
      resetUrl: "https://example.com/reset?token=t",
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain("&lt;script&gt;");
    // Plain text version should NOT escape (it's text, not HTML)
    expect(out.text).toContain('<script>alert("xss")</script>');
  });

  it("HTML-escapes resetUrl in href context (defensive — URL builder should already encode)", () => {
    const out = passwordResetEmail({
      surface: "admin",
      fullName: "Alice",
      resetUrl: 'https://example.com/reset?token=a"><script>',
    });
    // Quote in href context becomes &quot;
    expect(out.html).not.toContain('"><script>');
  });

  it("includes expiry note and footer in both surfaces", () => {
    for (const surface of ["admin", "portal"] as const) {
      const out = passwordResetEmail({
        surface,
        fullName: "Test",
        resetUrl: "https://example.com",
      });
      expect(out.html).toContain("15 minutes");
      expect(out.text).toContain("15 minutes");
      expect(out.html).toContain("If you didn't request this");
    }
  });
});
