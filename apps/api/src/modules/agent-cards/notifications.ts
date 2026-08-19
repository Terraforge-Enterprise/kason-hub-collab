// Agent E-Namecard notification templates + dispatch helpers.
//
// Implements spec §11 (notification table) and §11.1 (verbatim template
// strings). Each helper is FIRE-AND-FORGET: callers invoke them after the
// surrounding $transaction has committed, errors are swallowed and logged,
// and they NEVER throw back into the route handler — a notification failure
// must not surface to the user as a 500 on the surrounding mutation.
//
// Channels per spec §11:
//   - In-app: writes one `Notification` row per recipient (the existing
//     `Notification` Prisma model from the communications module).
//   - WhatsApp: DEFERRED in v1. The existing `WhatsAppSender` interface is
//     Meta-template-based (named variables, pre-approved template names),
//     and the spec body strings here are free-text. Wiring the existing
//     sender would require either (a) defining + getting Meta to approve
//     6 new template names, or (b) building a free-text path. Both are
//     post-Phase-7 work. For now: the rendered body string is logged via
//     `console.warn("[agent-card-notify:whatsapp:pending]", ...)` so
//     production logs make the gap visible. The in-app notification IS
//     written, so the agent always sees the bell badge.
//
// Body interpolation safety (per spec §9.10 #31):
//   - All user-controlled fields ({agentName}, {newTitle}, {reason}) are
//     stored as plain text and rendered by React using `{value}` syntax,
//     which escapes by default. This module does NOT use
//     `dangerouslySetInnerHTML` — render-time consumers MUST also avoid it.
//
// Deeplink shape (per task constraints):
//   - All deeplinks are stored as RELATIVE URLs on `Notification.actionUrl`.
//     Render-time prepends the SPA origin. Manager pending → relative path
//     `/organization/agents/card-approvals?versionId={id}`. Agent
//     approval/rejection/reconfirm → relative `/portal/my-card`.
//
// Public URL composition:
//   - `{publicUrl}` in approval/reconfirm bodies needs an ABSOLUTE URL
//     (the agent shares it externally). We build it via APP_URL +
//     `/card/{publicToken}`. APP_URL is the same env var used elsewhere
//     (auth.service, portal.password-reset.service); falls back to
//     `https://app.kason-hub.com` if unset (matches task spec).

import { getDb } from "@kason/db";

// ── Helpers ─────────────────────────────────────────────────────────────────

const NOTIFICATION_DOMAIN = "agent-card";

function appBaseUrl(): string {
  // Same fallback shape as auth.service / portal.password-reset.service.
  return (
    process.env.APP_URL ||
    process.env.PUBLIC_APP_BASE_URL ||
    "https://app.kason-hub.com"
  );
}

/**
 * Composes the public-card URL from a publicToken. Strips any trailing
 * slash on APP_URL so we never emit `//card/...`.
 */
function publicCardUrl(publicToken: string): string {
  const base = appBaseUrl().replace(/\/$/, "");
  return `${base}/card/${publicToken}`;
}

/**
 * Stub WhatsApp send. Logs the rendered body and target phone so the gap
 * is visible in production logs but does NOT block on Meta template
 * approval. See module header for rationale.
 */
function stubWhatsAppSend(
  recipientPhone: string | null | undefined,
  body: string,
): void {
  if (!recipientPhone) return; // Nothing to send to.
  // TODO: WhatsApp sender pending — Meta template approval required for
  // free-text agent-card bodies (spec §11.1). In-app notification IS
  // recorded; this is the WhatsApp gap.
  console.warn("[agent-card-notify:whatsapp:pending]", {
    to: recipientPhone,
    body,
  });
}

/**
 * Writes a Notification row. Catches and logs any DB error so the caller
 * (which lives outside the surrounding mutation's $transaction) cannot
 * leak the failure back into the user-facing response.
 */
async function writeInApp(params: {
  organizationId: string;
  userId: string | null;
  title: string;
  body: string;
  actionUrl: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    await db.notification.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId,
        domain: NOTIFICATION_DOMAIN,
        title: params.title,
        body: params.body,
        actionUrl: params.actionUrl,
        read: false,
      },
    });
  } catch (err) {
    console.error("[agent-card-notify] failed to write Notification:", err);
  }
}

// ── Template renderers ──────────────────────────────────────────────────────
//
// Each renderer returns the EXACT body string from spec §11.1. Tests assert
// the verbatim shape so any drift fails the suite. Body strings live next
// to the renderer (rather than an importable constants block) so a reader
// scanning this file sees the spec text inline.

export function renderPendingSubmissionBody(params: {
  agentName: string;
  newTitle: string;
}): string {
  return `${params.agentName} submitted card changes (title: "${params.newTitle}"). Review.`;
}

export function renderApprovalBody(params: { publicUrl: string }): string {
  return `Your e-namecard was approved. View: ${params.publicUrl}`;
}

export function renderRejectionBody(params: {
  reason: string;
  portalUrl: string;
}): string {
  return `Your e-namecard update was rejected. Reason: ${params.reason}. Edit & re-submit: ${params.portalUrl}`;
}

export function renderReconfirmT30Body(params: { months: number }): string {
  return `Your e-namecard expires in 30 days. Re-confirm to extend by ${params.months} months.`;
}

export function renderReconfirmT7Body(params: { portalUrl: string }): string {
  return `Your e-namecard expires in 7 days. Re-confirm now to keep your public link active: ${params.portalUrl}`;
}

export function renderReconfirmT1Body(params: { portalUrl: string }): string {
  return `Your e-namecard expires tomorrow. Re-confirm now: ${params.portalUrl}`;
}

export function renderReconfirmCapBody(params: { portalUrl: string }): string {
  return `Your e-namecard has been re-confirmed 4 times. Submit fresh details for manager re-approval to keep your public link active: ${params.portalUrl}`;
}

// ── Recipient resolution ────────────────────────────────────────────────────

/**
 * Returns the User.id of the operator who owns this agent's portal session
 * (i.e. the User row whose partyId matches). Used to write the in-app
 * Notification row's userId. Returns null if the party has no linked user
 * (e.g. an agent who hasn't activated their portal account yet) — in that
 * case the in-app notification is written with userId=null and will only
 * appear org-wide rather than to a specific user.
 */
async function getUserIdForParty(partyId: string): Promise<string | null> {
  try {
    const db = getDb();
    const user = await db.user.findFirst({
      where: { partyId },
      select: { id: true },
    });
    return user?.id ?? null;
  } catch (err) {
    console.error("[agent-card-notify] failed to resolve user for party:", err);
    return null;
  }
}

/**
 * Returns the WhatsApp phone (E.164) for an agent's Party row, or null
 * when not set. Loaded once per notification dispatch.
 */
async function getAgentWhatsAppPhone(partyId: string): Promise<string | null> {
  try {
    const db = getDb();
    const party = await db.party.findUnique({
      where: { id: partyId },
      select: { whatsappPhone: true },
    });
    return party?.whatsappPhone ?? null;
  } catch (err) {
    console.error("[agent-card-notify] failed to load party whatsappPhone:", err);
    return null;
  }
}

// ── Manager fan-out ─────────────────────────────────────────────────────────

/**
 * Writes one in-app Notification row per operator user with role
 * `manager` or `admin` in the org. Used for the "new pending submission"
 * event (spec §11 row 1 — In-app only, no WhatsApp).
 *
 * Selection criteria:
 *   - `User.organizationId = orgId`
 *   - `User.role IN ('manager', 'admin')`
 *   - `User.userType = 'operator'` (excludes 'agent' portal users; an agent
 *     who happens to also have a manager role on a different org would
 *     still be filtered correctly here because we scope by orgId)
 *   - `User.status = 'active'` (skip suspended users)
 */
export async function notifyAllManagersInOrg(params: {
  organizationId: string;
  title: string;
  body: string;
  actionUrl: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    const recipients = await db.user.findMany({
      where: {
        organizationId: params.organizationId,
        role: { in: ["manager", "admin"] },
        userType: "operator",
        status: "active",
      },
      select: { id: true },
    });
    // Sequential writes; recipients per org are typically <10. If this
    // ever grows we can swap to a single createMany.
    for (const recipient of recipients) {
      await writeInApp({
        organizationId: params.organizationId,
        userId: recipient.id,
        title: params.title,
        body: params.body,
        actionUrl: params.actionUrl,
      });
    }
  } catch (err) {
    console.error("[agent-card-notify] manager fan-out failed:", err);
  }
}

// ── Per-event helpers ───────────────────────────────────────────────────────
//
// One named function per row in spec §11. All are async fire-and-forget;
// the caller `void`s the returned promise. Errors are swallowed inside.

/**
 * Spec §11 row 1 — New pending submission. Recipients: all operator
 * users with role manager/admin in the org. Channels: in-app ONLY.
 * Deeplink: `/organization/agents/card-approvals?versionId={id}`.
 */
export async function notifyManagersOfPendingCard(params: {
  organizationId: string;
  versionId: string;
  agentName: string;
  newTitle: string;
}): Promise<void> {
  const body = renderPendingSubmissionBody({
    agentName: params.agentName,
    newTitle: params.newTitle,
  });
  const actionUrl = `/organization/agents/card-approvals?versionId=${params.versionId}`;
  await notifyAllManagersInOrg({
    organizationId: params.organizationId,
    title: "Card approval pending",
    body,
    actionUrl,
  });
}

/**
 * Spec §11 row 2 — Approval. Recipient: the agent. Channels: in-app +
 * WhatsApp (using Party.whatsappPhone if set).
 */
export async function notifyAgentCardApproved(params: {
  organizationId: string;
  agentPartyId: string;
  publicToken: string;
}): Promise<void> {
  const publicUrl = publicCardUrl(params.publicToken);
  const body = renderApprovalBody({ publicUrl });
  const userId = await getUserIdForParty(params.agentPartyId);
  await writeInApp({
    organizationId: params.organizationId,
    userId,
    title: "E-namecard approved",
    body,
    actionUrl: "/portal/my-card",
  });
  const phone = await getAgentWhatsAppPhone(params.agentPartyId);
  stubWhatsAppSend(phone, body);
}

/**
 * Spec §11 row 3 — Rejection (with reason). Recipient: the agent.
 * Channels: in-app + WhatsApp.
 */
export async function notifyAgentCardRejected(params: {
  organizationId: string;
  agentPartyId: string;
  reason: string;
}): Promise<void> {
  const portalUrl = `${appBaseUrl().replace(/\/$/, "")}/portal/my-card`;
  const body = renderRejectionBody({ reason: params.reason, portalUrl });
  const userId = await getUserIdForParty(params.agentPartyId);
  await writeInApp({
    organizationId: params.organizationId,
    userId,
    title: "E-namecard update rejected",
    body,
    actionUrl: "/portal/my-card",
  });
  const phone = await getAgentWhatsAppPhone(params.agentPartyId);
  stubWhatsAppSend(phone, body);
}

/**
 * Spec §11 row 4 — Reconfirm reminders. Three windows: T-30 (in-app
 * only), T-7 (in-app + WhatsApp), T-1 (in-app + WhatsApp). Phase 9 will
 * wire the cron caller; this exposes the helpers ready to use.
 */
export async function notifyAgentReconfirmT30(params: {
  organizationId: string;
  agentPartyId: string;
  cardExpiryMonths: number;
}): Promise<void> {
  const body = renderReconfirmT30Body({ months: params.cardExpiryMonths });
  const userId = await getUserIdForParty(params.agentPartyId);
  await writeInApp({
    organizationId: params.organizationId,
    userId,
    title: "E-namecard expires in 30 days",
    body,
    actionUrl: "/portal/my-card",
  });
  // Spec §11: T-30 is in-app only; no WhatsApp.
}

export async function notifyAgentReconfirmT7(params: {
  organizationId: string;
  agentPartyId: string;
}): Promise<void> {
  const portalUrl = `${appBaseUrl().replace(/\/$/, "")}/portal/my-card`;
  const body = renderReconfirmT7Body({ portalUrl });
  const userId = await getUserIdForParty(params.agentPartyId);
  await writeInApp({
    organizationId: params.organizationId,
    userId,
    title: "E-namecard expires in 7 days",
    body,
    actionUrl: "/portal/my-card",
  });
  const phone = await getAgentWhatsAppPhone(params.agentPartyId);
  stubWhatsAppSend(phone, body);
}

export async function notifyAgentReconfirmT1(params: {
  organizationId: string;
  agentPartyId: string;
}): Promise<void> {
  const portalUrl = `${appBaseUrl().replace(/\/$/, "")}/portal/my-card`;
  const body = renderReconfirmT1Body({ portalUrl });
  const userId = await getUserIdForParty(params.agentPartyId);
  await writeInApp({
    organizationId: params.organizationId,
    userId,
    title: "E-namecard expires tomorrow",
    body,
    actionUrl: "/portal/my-card",
  });
  const phone = await getAgentWhatsAppPhone(params.agentPartyId);
  stubWhatsAppSend(phone, body);
}

/**
 * Spec §11 row 5 — Reconfirm cap reached (reconfirmCount=4). Recipient:
 * the agent. Channels: in-app + WhatsApp.
 */
export async function notifyAgentReconfirmCapReached(params: {
  organizationId: string;
  agentPartyId: string;
}): Promise<void> {
  const portalUrl = `${appBaseUrl().replace(/\/$/, "")}/portal/my-card`;
  const body = renderReconfirmCapBody({ portalUrl });
  const userId = await getUserIdForParty(params.agentPartyId);
  await writeInApp({
    organizationId: params.organizationId,
    userId,
    title: "E-namecard re-confirm cap reached",
    body,
    actionUrl: "/portal/my-card",
  });
  const phone = await getAgentWhatsAppPhone(params.agentPartyId);
  stubWhatsAppSend(phone, body);
}
