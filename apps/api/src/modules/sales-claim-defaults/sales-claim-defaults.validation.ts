import { z } from "zod";

const splitInput = z.object({
  roleLabel: z.string().trim().min(1).max(100),
  splitType: z.enum(["percent", "fixed"]),
  splitValue: z.number().min(0),
  sortOrder: z.number().int().min(0).max(100).default(0),
});

export const upsertDefaultsSchema = z
  .object({
    appliesTo: z.string().trim().min(1).max(40).default("__catchall__"),
    commissionType: z.enum(["percent_of_purchase", "fixed"]),
    commissionValue: z.number().min(0),
    paymentType: z.enum(["full", "partial"]).default("full"),
    notes: z.string().trim().max(2000).nullable().optional(),
    splits: z.array(splitInput).min(1).max(20),
  })
  .strict()
  .superRefine((data, ctx) => {
    const labels = new Set<string>();
    for (const s of data.splits) {
      const key = s.roleLabel.toLowerCase();
      if (labels.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate roleLabel "${s.roleLabel}".`,
          path: ["splits"],
        });
      }
      labels.add(key);
    }
    // If every split is percent type, sum must be 100 within ±0.01.
    if (data.splits.every((s) => s.splitType === "percent")) {
      const sum = data.splits.reduce((acc, s) => acc + s.splitValue, 0);
      if (Math.abs(sum - 100) > 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Percent splits must sum to 100 (got ${sum.toFixed(2)}).`,
          path: ["splits"],
        });
      }
    }
  });

export type UpsertDefaultsInput = z.infer<typeof upsertDefaultsSchema>;
