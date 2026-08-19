import { z } from "zod";

/** PATCH /api/profile/me — operator self-update. */
export const updateMyProfileSchema = z
  .object({
    fullName: z.string().min(1).max(200).optional(),
    photoKey: z.string().nullable().optional(),
  })
  .refine((d) => d.fullName !== undefined || d.photoKey !== undefined, {
    message: "At least one field must be provided",
  });

export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;

/** POST /api/profile/avatar/upload-url — request a signed upload URL. */
export const avatarUploadUrlSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"], {
    error: "contentType must be image/jpeg, image/png, or image/webp",
  }),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024, "Max 5MB"),
});

export type AvatarUploadUrlInput = z.infer<typeof avatarUploadUrlSchema>;
