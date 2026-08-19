import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  fullName: z.string().min(1, "Full name is required"),
  role: z.enum(["manager", "editor", "viewer", "accountant"], {
    error: 'Role must be "manager", "editor", "viewer", or "accountant"',
  }),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    fullName: z.string().min(1).max(200).optional(),
    role: z.enum(["manager", "editor", "viewer", "accountant"]).optional(),
  })
  .refine((d) => d.fullName !== undefined || d.role !== undefined, {
    message: "At least one field must be provided",
  });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
