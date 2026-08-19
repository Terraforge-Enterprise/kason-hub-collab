import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetaCloudSender } from "../meta-cloud-sender";

describe("MetaCloudSender", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts the right body shape to Graph API and returns the message id", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.HBgMNjAxMjM0NTY3ODkVAgARGBI..." }] }),
    });
    const sender = new MetaCloudSender({ phoneId: "PHONE_ID", accessToken: "TOKEN" });
    const result = await sender.sendTemplate({
      to: "+60123456789",
      templateName: "new_claim_v1",
      languageCode: "en",
      variables: ["NX-2026-0042", "Ahmad", "1,234.50", "https://example/portal/claims/abc"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerMessageId).toMatch(/^wamid\./);
    }
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v22.0/PHONE_ID/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer TOKEN",
          "Content-Type": "application/json",
        }),
      }),
    );
    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody).toEqual({
      messaging_product: "whatsapp",
      to: "+60123456789",
      type: "template",
      template: {
        name: "new_claim_v1",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "NX-2026-0042" },
              { type: "text", text: "Ahmad" },
              { type: "text", text: "1,234.50" },
              { type: "text", text: "https://example/portal/claims/abc" },
            ],
          },
        ],
      },
    });
  });

  it("returns ok=false retriable=true on 5xx", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    });
    const sender = new MetaCloudSender({ phoneId: "P", accessToken: "T" });
    const result = await sender.sendTemplate({
      to: "+60", templateName: "t", languageCode: "en", variables: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(true);
    }
  });

  it("returns ok=false retriable=false on 4xx (e.g. invalid phone)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"invalid recipient"}}',
    });
    const sender = new MetaCloudSender({ phoneId: "P", accessToken: "T" });
    const result = await sender.sendTemplate({
      to: "+0", templateName: "t", languageCode: "en", variables: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(false);
      expect(result.error).toContain("invalid recipient");
    }
  });

  it("prepends + to canonical phone for Meta Cloud API E.164 boundary", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.canonical" }] }),
    });
    const sender = new MetaCloudSender({ phoneId: "P", accessToken: "T" });
    await sender.sendTemplate({
      to: "60123456789", // canonical, no plus
      templateName: "t",
      languageCode: "en",
      variables: [],
    });
    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.to).toBe("+60123456789");
  });

  it("does not double-prepend + when caller already provided E.164", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.e164" }] }),
    });
    const sender = new MetaCloudSender({ phoneId: "P", accessToken: "T" });
    await sender.sendTemplate({
      to: "+60123456789",
      templateName: "t",
      languageCode: "en",
      variables: [],
    });
    const callBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(callBody.to).toBe("+60123456789");
  });

  it("returns ok=false retriable=true on network error (fetch throws)", async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error("ECONNRESET"));
    const sender = new MetaCloudSender({ phoneId: "P", accessToken: "T" });
    const result = await sender.sendTemplate({
      to: "+60", templateName: "t", languageCode: "en", variables: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retriable).toBe(true);
      expect(result.error).toContain("ECONNRESET");
    }
  });
});
