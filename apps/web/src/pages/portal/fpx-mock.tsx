import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

/**
 * MOCK FPX bank page — a deliberately-plain stand-in for the external bank
 * redirect target. In production the FPX gateway redirects the payer to the
 * real bank's online-banking page; in dev/CI the in-process MockFpxGateway
 * redirects here (`/portal/fpx/mock?txn=<providerTxnId>&amount=<amount>`).
 *
 * The two buttons POST the outcome to the PUBLIC `/webhooks/fpx/mock-confirm`
 * webhook. That endpoint lives at the app ROOT — NOT under `/portal-api` — so we
 * use a plain `fetch` against the public API base (`VITE_PUBLIC_API_BASE`), never
 * `portalApiFetch` (whose base is `/portal-api`). The server then signs the
 * callback exactly as a real bank
 * would and runs the same settle path, so no client-forgeable signature exists.
 * We then return the payer to `/portal/payments?fpx=success|failed`.
 *
 * Intentionally NOT styled like the rest of the portal (inline styles, no design
 * tokens) — it represents a third-party page, and the visual mismatch is the
 * point. Route is flag-gated on VITE_ENABLE_PHASE2_FPX in router.tsx.
 */
export default function PortalFpxMockPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const providerTxnId = params.get("txn") ?? "";
  const amount = params.get("amount") ?? "0.00";
  const [submitting, setSubmitting] = useState(false);

  async function confirm(outcome: "success" | "failure") {
    if (submitting) return;
    setSubmitting(true);
    try {
      // The webhook lives at the API ROOT (not /portal-api). On split-origin
      // deploys the web SPA (CloudFront) and API (Lightsail) are DIFFERENT
      // origins, so a bare same-origin fetch hits CloudFront and silently
      // returns index.html — the settle never reaches the API. Prefix with the
      // public API base (empty in local dev → vite proxies /webhooks), matching
      // public-card/api.ts.
      const apiBase = import.meta.env.VITE_PUBLIC_API_BASE ?? "";
      await fetch(`${apiBase}/webhooks/fpx/mock-confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerTxnId, outcome }),
      });
    } catch {
      // A network error to the mock webhook still returns the payer to the
      // payments page as a failure — never strand them on this stand-in page.
    }
    navigate(`/portal/payments?fpx=${outcome === "success" ? "success" : "failed"}`);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f172a",
        padding: 24,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          background: "#ffffff",
          color: "#0f172a",
          borderRadius: 12,
          padding: 28,
          boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1,
            color: "#16a34a",
            textTransform: "uppercase",
          }}
        >
          FPX Online Banking
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, marginBottom: 22 }}>
          Mock payment gateway — test environment
        </div>

        <div style={{ fontSize: 13, color: "#64748b" }}>Amount to pay</div>
        <div style={{ fontSize: 30, fontWeight: 800, marginBottom: 4 }}>RM {amount}</div>
        <div
          style={{
            fontSize: 11,
            color: "#94a3b8",
            marginBottom: 24,
            wordBreak: "break-all",
          }}
        >
          Ref: {providerTxnId || "—"}
        </div>

        <button
          type="button"
          onClick={() => confirm("success")}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "12px 16px",
            background: "#16a34a",
            color: "#ffffff",
            border: "none",
            borderRadius: 8,
            fontSize: 15,
            fontWeight: 700,
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          Pay RM {amount}
        </button>
        <button
          type="button"
          onClick={() => confirm("failure")}
          disabled={submitting}
          style={{
            width: "100%",
            padding: "10px 16px",
            marginTop: 10,
            background: "transparent",
            color: "#dc2626",
            border: "1px solid #fca5a5",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          Simulate failure
        </button>
      </div>
    </div>
  );
}
