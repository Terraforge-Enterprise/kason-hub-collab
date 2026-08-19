import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mountWhatsAppWebhook } from "../whatsapp.routes";

describe("whatsapp webhook", () => {
  let app: Hono;
  let prisma: any;
  beforeEach(() => {
    process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test-token";
    prisma = {
      notificationLog: {
        update: vi.fn(async () => ({ id: "log-1" })),
        findFirst: vi.fn(async () => ({ id: "log-1", recipientPartyId: "p1" })),
      },
      party: {
        update: vi.fn(async () => ({ id: "p1" })),
        findFirst: vi.fn(async () => ({ id: "p1" })),
      },
    };
    app = new Hono();
    mountWhatsAppWebhook(app, { prisma });
  });

  it("GET ?hub.challenge=ABC&hub.verify_token=test-token → 200 ABC", async () => {
    const res = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=ABC");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ABC");
  });

  it("GET with wrong token → 403", async () => {
    const res = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ABC");
    expect(res.status).toBe(403);
  });

  it("POST status=delivered updates the matching NotificationLog row", async () => {
    const body = {
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    };
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(prisma.notificationLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerMessageId: "wamid.X" }, data: { status: "delivered" } }),
    );
  });

  it("POST inbound text='STOP' from a known number flips Party.notifyOnNewClaim=false", async () => {
    const body = {
      entry: [{ changes: [{ value: { messages: [{ from: "60111", text: { body: "STOP" } }] } }] }],
    };
    const res = await app.request("/webhooks/whatsapp", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(prisma.party.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1" }, data: { notifyOnNewClaim: false } }),
    );
  });
});
