// Public e-namecard page (per spec §6.3, §7.3).
//
// Renders the shared <AgentCardPreview> with no auth, plus three actions:
//   1. Save to Contacts — vCard download (sanitized per §9.10)
//   2. Download PNG     — html2canvas snapshot, alert-on-failure
//   3. WhatsApp         — wa.me deep link with whitelist-gated greeting
//
// State machine: loading → ok | not-found | error.
//   - not-found: terminal, no retry button — the link genuinely isn't valid.
//   - error: transient (network), exposes a Retry that re-runs the fetch.
//   - 10s fetch timeout via AbortController so a stalled CDN doesn't hang
//     the spinner indefinitely.
//
// IMPORTANT: this file lives outside src/pages/** intentionally — it's
// loaded by a separate Vite entry (card.html) so the public bundle does not
// pull in the admin/portal SPA. Imports are restricted to React, react-router
// (already shared via vendor chunk), the shared <AgentCardPreview>
// component, and our own files in src/public-card/. Do NOT add admin or
// portal imports here.

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchPublicCard } from "./api";
import { downloadVCard } from "./v-card";
import { exportCardAsPng } from "./png-export";
import { buildWhatsAppLink } from "./whatsapp";
import { AgentCardPreview } from "../components/agent-card-preview";
import type { PublicCardDto } from "./types";

const FETCH_TIMEOUT_MS = 10_000;

export function PublicCardPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicCardDto | null>(null);
  // Lazy initializer: when the route param is missing we go straight to the
  // not-found render path WITHOUT firing an effect-level setState (which the
  // react-hooks/set-state-in-effect rule rightly flags). The effect below
  // bails when token is empty, so no fetch is issued either.
  const [state, setState] = useState<
    "loading" | "ok" | "not-found" | "error"
  >(() => (token ? "loading" : "not-found"));
  const [retryKey, setRetryKey] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    fetchPublicCard(token, controller.signal)
      .then((dto) => {
        clearTimeout(timeoutId);
        if (dto === null) {
          setState("not-found");
        } else {
          setData(dto);
          setState("ok");
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (err?.name !== "AbortError") {
          console.error("[public-card] fetch failed", err);
        }
        setState("error");
      });

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [token, retryKey]);

  if (state === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (state === "not-found") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center px-6">
        <div className="text-6xl opacity-20 mb-4" aria-hidden="true">
          🪪
        </div>
        <h1 className="text-xl font-semibold mb-2">
          This card is no longer available
        </h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          The link may have expired, been revoked, or the agent's account is
          no longer active.
        </p>
        <a
          href="/"
          className="text-xs mt-6 text-muted-foreground hover:text-foreground"
        >
          Powered by KAEN PROPERTIES
        </a>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-center px-6">
        <h1 className="text-xl font-semibold mb-2">Could not load card</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          Network error. Please check your connection.
        </p>
        <button
          type="button"
          className="mt-6 px-4 py-2 rounded bg-primary text-primary-foreground"
          onClick={() => {
            setState("loading");
            setRetryKey((k) => k + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const publicUrl = window.location.href;
  const waLink = buildWhatsAppLink(
    data.displayName,
    data.whatsappPhone,
    data.primaryPhone,
    publicUrl,
  );

  const handleDownloadPng = async () => {
    if (!cardRef.current) return;
    try {
      const filename = `${data.displayName
        .replace(/\s+/g, "-")
        .toLowerCase()}-namecard.png`;
      await exportCardAsPng(cardRef.current, filename);
    } catch (err) {
      console.error("[public-card] PNG export failed", err);
      // Best-effort UX: alert is intentionally minimal — the page already
      // shows the URL, so visitors can fall back to sharing the link.
      alert("Download failed — please share the link directly.");
    }
  };

  return (
    <div className="min-h-screen bg-background py-12 px-4 flex flex-col items-center">
      <div ref={cardRef} className="max-w-2xl w-full">
        <AgentCardPreview
          displayName={data.displayName}
          title={data.title}
          primaryPhone={data.primaryPhone}
          primaryEmail={data.primaryEmail}
          whatsappPhone={data.whatsappPhone}
          org={data.org}
        />
      </div>

      <div className="flex flex-wrap gap-3 mt-6 max-w-2xl w-full justify-center">
        <button
          type="button"
          onClick={() => downloadVCard(data)}
          className="bg-[#d4af37] text-black px-4 py-2 rounded-full text-sm font-semibold"
        >
          Save to Contacts (vCard)
        </button>
        <button
          type="button"
          onClick={handleDownloadPng}
          className="border border-[#d4af37] text-[#d4af37] px-4 py-2 rounded-full text-sm font-semibold"
        >
          Download PNG
        </button>
        {waLink && (
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            className="border border-[#25d366] text-[#25d366] px-4 py-2 rounded-full text-sm font-semibold flex items-center gap-1"
          >
            WhatsApp
          </a>
        )}
      </div>

      {data.listings.length > 0 && (
        <div className="max-w-2xl w-full mt-12">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-3">
            Active listings ({data.listings.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.listings.map((l) => (
              <div
                key={l.id}
                className="rounded-lg border border-border/50 bg-card overflow-hidden"
              >
                <div className="p-3">
                  <div className="font-medium text-sm truncate">
                    {l.addressLine}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {l.type}
                    {l.bedrooms != null && ` · ${l.bedrooms} bed`}
                    {l.bathrooms != null && ` · ${l.bathrooms} bath`}
                    {l.sizeSqft != null && ` · ${l.sizeSqft} sqft`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <a
        href="/"
        className="text-xs mt-12 text-muted-foreground hover:text-foreground"
      >
        Powered by KAEN PROPERTIES
      </a>
    </div>
  );
}
