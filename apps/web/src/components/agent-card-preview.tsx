/**
 * AgentCardPreview — the dark/gold e-namecard visual artifact.
 *
 * This is the SINGLE shared component used by all four surfaces:
 *   1. Admin agent-detail E-Namecard sub-section
 *   2. Portal /portal/my-card "Live card" panel
 *   3. Public /card/:token page
 *   4. PNG export pipeline (snapshotted by html2canvas)
 *
 * SIZING strategy: the inner card is FIXED at 720×440 px (Malaysian
 * business-card proportion ~1.636:1 — matches a printed real-estate
 * namecard at 90×55mm). Internal text uses fixed px values (NOT Tailwind
 * text-sm/text-base) so proportions are preserved when html2canvas
 * snapshots to PNG.
 *
 * RESPONSIVE strategy: a `ResizeObserver` watches the wrapper width and
 * sets a `transform: scale(...)` on the inner card via React state. This
 * is dead-reliable across all browsers (no container-query support
 * concerns). The card SHRINKS to fit the wrapper but never grows past 1.0
 * (so it stays at native size on desktop). The wrapper's height is
 * computed dynamically as `440 * scale` so the card occupies exactly its
 * visible space in the page flow — no oversized empty box on mobile.
 *
 * As a belt-and-suspenders fallback, the wrapper also sets
 * `overflow-x: auto` so if scaling somehow fails the user can horizontally
 * pan to see the rest of the card.
 *
 * PNG export: `html2canvas` snapshots the un-scaled inner element via the
 * `data-png-export-target` attribute, so the exported image is always the
 * full 720×440 regardless of how it's currently scaled on screen.
 *
 * Per spec §7.4 this is a PURE render — no data fetching inside.
 */
import { Phone, Mail, MapPin } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMyPhoneDisplay, readPhoneAnyFormat } from "@kason/shared";

const CARD_WIDTH = 720;
const CARD_HEIGHT = 440;

export interface AgentCardPreviewProps {
  displayName: string;
  title: string;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  /**
   * Governs the WhatsApp tap-action on the public page wrapper. Not rendered
   * on the visual card itself — the card displays `primaryPhone`. The wrapper
   * (PublicCardPage) handles the wa.me link logic.
   */
  whatsappPhone?: string | null;
  org: {
    agencyName: string | null;
    agencyLicense: string | null;
    agencyPhone: string | null;
    agencyFax: string | null;
    address: string[];
    logoUrl: string;
  };
}

export function AgentCardPreview({
  displayName,
  title,
  primaryPhone,
  primaryEmail,
  whatsappPhone: _whatsappPhone,
  org,
}: AgentCardPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  // The card is shared with the public-card surface, where the snapshot
  // payload may still carry legacy `+60`-prefixed values from
  // un-backfilled UAT data. Normalize on read and pre-format for display
  // here — the admin/portal call-sites pass a canonical `60XXXXXXXXX`
  // value and get the same friendly result, while the public-card path
  // gets defensive normalization without hitting any unparseable input.
  const formattedPhone = useMemo(() => {
    const canonical = readPhoneAnyFormat(primaryPhone);
    return canonical ? formatMyPhoneDisplay(canonical) : null;
  }, [primaryPhone]);

  // Watch the wrapper width and re-compute scale on every resize. Cap at 1.0
  // so the card never grows past its native size on wide desktops.
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const update = () => {
      const w = el.clientWidth;
      const next = Math.min(1, w / CARD_WIDTH);
      setScale(next > 0 ? next : 1);
    };

    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Outer wrapper: full available width up to 720px, height shrinks with scale.
  // overflow-x: auto is a fallback in case scale calculation lags on first paint.
  return (
    <div
      ref={wrapperRef}
      data-testid="agent-card-preview-wrap"
      style={{
        width: "100%",
        maxWidth: CARD_WIDTH,
        marginInline: "auto",
        height: CARD_HEIGHT * scale,
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {/* The card itself — always rendered at the native 720×440 size, then
          visually scaled via CSS transform. PNG export targets this node. */}
      <div
        data-testid="agent-card-preview"
        data-png-export-target="true"
        style={{
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          transformOrigin: "top left",
          transform: `scale(${scale})`,
          background: "#000",
          color: "#fff",
          border: "1px solid rgba(212,175,55,0.25)",
          borderRadius: 8,
          boxShadow: "0 24px 48px rgba(212,175,55,0.08)",
          fontFamily: "system-ui, -apple-system, sans-serif",
          display: "grid",
          gridTemplateColumns: "1.35fr 1fr",
          gridTemplateRows: "1fr auto",
          columnGap: 20,
          padding: 32,
          boxSizing: "border-box",
        }}
      >
        {/* LEFT — identity + contact block */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-start",
          }}
        >
          {/* Name + title — anchor of the card. Match sample's bold prominence. */}
          <h1
            style={{
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: "0.04em",
              margin: 0,
              marginBottom: 4,
              textTransform: "uppercase",
              lineHeight: 1.0,
            }}
          >
            {displayName}
          </h1>
          <p
            style={{
              fontSize: 17,
              color: "rgba(255,255,255,0.88)",
              margin: 0,
              marginBottom: 28,
              fontWeight: 400,
              letterSpacing: "0.005em",
            }}
          >
            {title}
          </p>

          {/* Contact rows — comfortable read size, gold icons, generous spacing. */}
          {(formattedPhone || primaryPhone) && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
                margin: "8px 0",
                fontSize: 14,
                lineHeight: 1.45,
              }}
            >
              <Phone style={{ width: 18, height: 18, marginTop: 1, color: "#d4af37", flexShrink: 0 }} />
              <span>{formattedPhone ?? primaryPhone}</span>
            </div>
          )}
          {primaryEmail && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
                margin: "8px 0",
                fontSize: 13.5,
                lineHeight: 1.45,
                wordBreak: "break-word",
              }}
            >
              <Mail style={{ width: 18, height: 18, marginTop: 1, color: "#d4af37", flexShrink: 0 }} />
              <span>{primaryEmail}</span>
            </div>
          )}
          {org.address.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
                margin: "8px 0",
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              <MapPin style={{ width: 18, height: 18, marginTop: 1, color: "#d4af37", flexShrink: 0 }} />
              <div>
                {org.address.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — logo dominant in its column. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
          }}
        >
          <img
            src={org.logoUrl}
            alt="Logo"
            style={{ width: 220, height: 220, objectFit: "contain" }}
          />
        </div>

        {/* FOOTER — full-width strip with agency cert + Ejen Hartanah box */}
        {(org.agencyName || org.agencyLicense) && (
          <div
            style={{
              gridColumn: "1 / -1",
              borderTop: "1px solid rgba(212,175,55,0.4)",
              paddingTop: 12,
              marginTop: 10,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              fontSize: 11,
              color: "rgba(255,255,255,0.7)",
              lineHeight: 1.4,
            }}
          >
            <div>
              {org.agencyName} {org.agencyLicense && org.agencyLicense}
              {org.agencyPhone && (
                <>
                  <br />
                  Tel: {org.agencyPhone}
                </>
              )}
              {org.agencyFax && (
                <>
                  <br />
                  Fax: {org.agencyFax}
                </>
              )}
            </div>
            {org.agencyLicense && (
              <div style={{ textAlign: "center", color: "rgba(255,255,255,0.85)", fontSize: 10 }}>
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.85)",
                    width: 26,
                    height: 26,
                    margin: "0 auto 4px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    borderRadius: 2,
                  }}
                >
                  ★
                </div>
                Ejen Hartanah
                <br />
                {org.agencyLicense}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
