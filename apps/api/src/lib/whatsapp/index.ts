import type { WhatsAppSender } from "./sender";
import { StubSender } from "./stub-sender";
import { MetaCloudSender } from "./meta-cloud-sender";

export type { WhatsAppSender, SendTemplateInput, SendTemplateResult } from "./sender";
export { StubSender } from "./stub-sender";
export { MetaCloudSender } from "./meta-cloud-sender";

let cached: WhatsAppSender | null = null;

/**
 * Returns the configured WhatsAppSender. Selection by env:
 * - WHATSAPP_PROVIDER=meta + the META_* keys → MetaCloudSender
 * - anything else → StubSender (dev/CI default)
 *
 * The result is memoized for the process lifetime. Tests should call
 * `resetWhatsAppSender()` between cases when needed.
 */
export function getWhatsAppSender(): WhatsAppSender {
  if (cached) return cached;
  if (process.env.WHATSAPP_PROVIDER === "meta") {
    const phoneId = process.env.META_WHATSAPP_PHONE_ID;
    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    if (!phoneId || !accessToken) {
      throw new Error("WHATSAPP_PROVIDER=meta requires META_WHATSAPP_PHONE_ID and META_WHATSAPP_ACCESS_TOKEN");
    }
    cached = new MetaCloudSender({ phoneId, accessToken });
  } else {
    cached = new StubSender();
  }
  return cached;
}

export function resetWhatsAppSender(): void {
  cached = null;
}
