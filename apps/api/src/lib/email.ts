import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const sesClient = new SESClient({
  region: process.env.SES_REGION || "ap-southeast-5",
  credentials:
    process.env.SES_AWS_ACCESS_KEY_ID && process.env.SES_AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.SES_AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.SES_AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const DEFAULT_FROM = process.env.SES_FROM_EMAIL || "noreply@kaenproperties.com";

export interface SendEmailParams {
  to: string;
  subject: string;
  /** HTML body. */
  body: string;
  /** Optional plain-text fallback. Improves spam score and serves text-only clients. */
  text?: string;
  from?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
  // Dev/test short-circuit: print payload to stdout instead of sending. Read
  // at call time (not module load) so tests can flip the env between runs.
  if (process.env.EMAIL_DEV_CAPTURE === "stdout") {
    // eslint-disable-next-line no-console
    console.info(JSON.stringify({ event: "email.dev_capture", to: params.to, subject: params.subject, htmlPreview: params.body.slice(0, 200), textPreview: params.text?.slice(0, 200) }));
    return { success: true, messageId: "dev-capture" };
  }

  try {
    const Body: { Html: { Data: string; Charset: string }; Text?: { Data: string; Charset: string } } = {
      Html: { Data: params.body, Charset: "UTF-8" },
    };
    if (params.text) {
      Body.Text = { Data: params.text, Charset: "UTF-8" };
    }
    const result = await sesClient.send(
      new SendEmailCommand({
        Source: params.from || DEFAULT_FROM,
        Destination: { ToAddresses: [params.to] },
        Message: {
          Subject: { Data: params.subject, Charset: "UTF-8" },
          Body,
        },
      }),
    );
    return { success: true, messageId: result.MessageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
