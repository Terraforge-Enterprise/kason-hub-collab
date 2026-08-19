import { z } from "zod";

export const createNotificationSchema = z.object({
  userId: z.string().uuid().optional().or(z.literal("")),
  domain: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  actionUrl: z.string().optional(),
});

export const enqueueNotificationSchema = z.object({
  type: z.string().default("general"),
  recipientEmail: z.string().email(),
  recipientName: z.string().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  channel: z.enum(["email", "sms", "push", "whatsapp"]).default("email"),
});
