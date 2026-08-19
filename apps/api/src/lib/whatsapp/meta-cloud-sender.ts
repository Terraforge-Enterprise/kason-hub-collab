import type { SendTemplateInput, SendTemplateResult, WhatsAppSender } from "./sender";

export type MetaCloudSenderConfig = {
  phoneId: string;
  accessToken: string;
  apiVersion?: string;
};

/**
 * Meta Cloud API requires strict E.164 (`+60...`) at the request boundary,
 * but the rest of the system stores canonical `60XXXXXXXXX` (no `+`). Prepend
 * `+` only here, at the API boundary, so callers can pass either form.
 */
function ensureLeadingPlus(phone: string): string {
  return phone.startsWith("+") ? phone : "+" + phone;
}

export class MetaCloudSender implements WhatsAppSender {
  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor(cfg: MetaCloudSenderConfig) {
    const v = cfg.apiVersion ?? "v22.0";
    this.endpoint = `https://graph.facebook.com/${v}/${cfg.phoneId}/messages`;
    this.accessToken = cfg.accessToken;
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
    const body = {
      messaging_product: "whatsapp",
      to: ensureLeadingPlus(input.to),
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: [
          {
            type: "body",
            parameters: input.variables.map((v) => ({ type: "text", text: v })),
          },
        ],
      },
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, retriable: true };
    }

    if (!response.ok) {
      const errorText = await response.text();
      const retriable = response.status >= 500;
      return { ok: false, error: errorText, retriable };
    }

    const json = (await response.json()) as { messages?: Array<{ id: string }> };
    const id = json.messages?.[0]?.id;
    if (!id) {
      return { ok: false, error: "Meta response missing message id", retriable: false };
    }
    return { ok: true, providerMessageId: id };
  }
}
