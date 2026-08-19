import { randomUUID } from "node:crypto";
import type { SendTemplateInput, SendTemplateResult, WhatsAppSender } from "./sender";

/**
 * Mask all but the last 4 digits of a phone for log output. Phone numbers are
 * PII and must never appear raw in stdout (CI artifacts, dev consoles, log
 * aggregators all read from there).
 */
function redactPhone(phone: string): string {
  if (!phone) return "****";
  if (phone.length < 4) return "*".repeat(phone.length);
  return "*".repeat(phone.length - 4) + phone.slice(-4);
}

/**
 * Logs the would-be send and returns success. Used in dev/CI so the dispatcher
 * + recipient resolver are exercised end-to-end without hitting Meta. Captures
 * the last call so tests can assert dispatcher behavior without mocking.
 *
 * Logs are redacted — phones are PII and must never appear raw in stdout.
 * The `lastCall` field preserves raw input for in-process test introspection only.
 */
export class StubSender implements WhatsAppSender {
  lastCall: SendTemplateInput | null = null;

  async sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
    this.lastCall = input;
    if (process.env.NODE_ENV !== "test") {
      const safe = { ...input, to: redactPhone(input.to) };
      console.log("[whatsapp:stub]", JSON.stringify(safe));
    }
    return { ok: true, providerMessageId: `stub-${randomUUID()}` };
  }
}
