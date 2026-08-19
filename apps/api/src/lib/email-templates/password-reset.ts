function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function passwordResetEmail(opts: {
  surface: "admin" | "portal";
  fullName: string;
  resetUrl: string;
}): { subject: string; html: string; text: string } {
  const { surface, fullName, resetUrl } = opts;
  const safeName = escapeHtml(fullName);
  const safeUrl = escapeHtml(resetUrl);
  const accountWord = surface === "admin" ? "admin" : "agent";

  const subject = "Reset your Kason-Hub password";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1f;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f7;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="480" cellspacing="0" cellpadding="0" border="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <tr><td style="padding-bottom:24px;">
        <span style="font-size:24px;font-weight:600;color:#7c3aed;letter-spacing:-0.02em;">Kason-Hub</span>
      </td></tr>
      <tr><td style="padding-bottom:16px;font-size:16px;line-height:1.5;">Hi ${safeName},</td></tr>
      <tr><td style="padding-bottom:24px;font-size:15px;line-height:1.6;color:#444;">We received a request to reset your Kason-Hub ${accountWord} password.</td></tr>
      <tr><td style="padding-bottom:24px;">
        <a href="${safeUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">Reset password</a>
      </td></tr>
      <tr><td style="padding-bottom:16px;font-size:13px;line-height:1.5;color:#666;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#7c3aed;word-break:break-all;">${safeUrl}</a></td></tr>
      <tr><td style="padding-bottom:24px;font-size:13px;line-height:1.5;color:#666;">This link expires in 15 minutes and can only be used once.</td></tr>
      <tr><td style="border-top:1px solid #ececf0;padding-top:16px;font-size:12px;line-height:1.5;color:#888;">If you didn't request this, ignore this email — your password won't change. If you keep getting these, contact your manager.</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const text = `Hi ${fullName},

We received a request to reset your Kason-Hub ${accountWord} password.

Reset your password: ${resetUrl}

This link expires in 15 minutes and can only be used once.

If you didn't request this, ignore this email — your password won't change. If you keep getting these, contact your manager.
`;

  return { subject, html, text };
}
