export type SendTemplateInput = {
  to: string;
  templateName: string;
  languageCode: string;
  variables: string[];
};

export type SendTemplateResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string; retriable: boolean };

export interface WhatsAppSender {
  sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult>;
}
