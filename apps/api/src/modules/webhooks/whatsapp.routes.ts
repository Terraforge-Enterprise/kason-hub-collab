import type { Hono } from "hono";

type Deps = { prisma: any };

export function mountWhatsAppWebhook(app: Hono, deps: Deps): void {
  // GET — Meta verification handshake
  app.get("/webhooks/whatsapp", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge") ?? "";
    const expected = process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (mode === "subscribe" && expected && token === expected) {
      return c.text(challenge, 200);
    }
    return c.text("forbidden", 403);
  });

  // POST — delivery status updates + inbound STOP
  app.post("/webhooks/whatsapp", async (c) => {
    const body = (await c.req.json().catch(() => null)) as any;
    if (!body?.entry) return c.text("ok", 200);

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const status of change.value?.statuses ?? []) {
          if (status.id && typeof status.status === "string") {
            try {
              await deps.prisma.notificationLog.update({
                where: { providerMessageId: status.id },
                data: { status: status.status },
              });
            } catch {
              // unknown id (race / not ours) — ignore
            }
          }
        }
        for (const msg of change.value?.messages ?? []) {
          const text = msg.text?.body?.trim()?.toUpperCase();
          if (text && /^(STOP|UNSUBSCRIBE|OPT.?OUT)$/.test(text)) {
            const phone = msg.from?.startsWith("+") ? msg.from : `+${msg.from}`;
            const party = await deps.prisma.party.findFirst({
              where: { whatsappPhone: phone },
              select: { id: true },
            });
            if (party) {
              await deps.prisma.party.update({
                where: { id: party.id },
                data: { notifyOnNewClaim: false },
              });
            }
          }
        }
      }
    }

    return c.text("ok", 200);
  });
}
