import { getDb } from "@kason/db";
import { sendEmail } from "../../lib/email";

const BATCH_SIZE = 10;
const CONCURRENCY = 5;
const MAX_RETRIES = 3;

type ClaimedItem = {
  id: string;
  recipientEmail: string;
  subject: string;
  body: string;
  retryCount: number;
};

/**
 * Atomically claim pending emails using FOR UPDATE SKIP LOCKED,
 * then process them in parallel with bounded concurrency.
 */
export async function processEmailQueue(orgId: string) {
  const db = getDb();

  // Atomic claim: SELECT FOR UPDATE SKIP LOCKED prevents duplicate processing
  const claimed: ClaimedItem[] = await db.$queryRawUnsafe(
    `UPDATE "NotificationQueue"
     SET "status" = 'processing', "updatedAt" = NOW()
     WHERE "id" IN (
       SELECT "id" FROM "NotificationQueue"
       WHERE "organizationId" = $1
         AND "status" = 'pending'
         AND "channel" = 'email'
         AND "retryCount" < $2
       ORDER BY "createdAt" ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING "id", "recipientEmail", "subject", "body", "retryCount"`,
    orgId,
    MAX_RETRIES,
    BATCH_SIZE,
  );

  if (claimed.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  // Process in chunks of CONCURRENCY for bounded parallelism
  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const chunk = claimed.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (item) => {
        const result = await sendEmail({
          to: item.recipientEmail,
          subject: item.subject,
          body: item.body,
        });

        if (result.success) {
          await db.notificationQueue.update({
            where: { id: item.id },
            data: { status: "sent", sentAt: new Date(), sesMessageId: result.messageId },
          });
          return true;
        } else {
          const newRetryCount = item.retryCount + 1;
          await db.notificationQueue.update({
            where: { id: item.id },
            data: {
              status: newRetryCount >= MAX_RETRIES ? "failed" : "pending",
              errorMessage: result.error,
              retryCount: newRetryCount,
            },
          });
          return false;
        }
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        sent++;
      } else {
        failed++;
      }
    }
  }

  return { processed: claimed.length, sent, failed };
}
