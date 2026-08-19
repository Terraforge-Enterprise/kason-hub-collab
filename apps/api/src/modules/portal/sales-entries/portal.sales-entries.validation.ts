import { z } from "zod";

const projectModeExisting = z.object({ mode: z.literal("existing"), id: z.string().uuid() });
const projectModeNew = z.object({
  mode: z.literal("new"),
  name: z.string().trim().min(1).max(120),
  developer: z.string().trim().min(1).max(120),
  city: z.string().trim().max(80).optional(),
  expectedHandover: z.string().datetime().optional(),
  notes: z.string().trim().max(1000).optional(),
});

const splitInput = z.object({
  partyPartyId: z.string().uuid().nullable().optional(),
  partyDisplayName: z.string().trim().min(1).max(120),
  roleLabel: z.string().trim().min(1).max(100),
  splitType: z.enum(["percent", "fixed"]),
  splitValue: z.number().min(0),
  isHouseKeep: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(100).default(0),
});

const documentInput = z.object({
  kind: z.string().trim().min(1).max(40),
  fileKey: z.string().trim().min(1).max(500),
  filename: z.string().trim().min(1).max(255),
});

const renovationBlock = z.object({
  packageId: z.string().uuid(),
  packagePrice: z.number().min(0),
  paymentType: z.enum(["full", "partial", "offset_from_rental"]),
  monthlyOffsetAmount: z.number().min(0).optional(),
  splits: z.array(splitInput).min(1).max(20),
  notes: z.string().trim().max(2000).nullable().optional(),
  documents: z.array(documentInput).optional(),
});

export const createSalesEntrySchema = z
  .object({
    project: z.discriminatedUnion("mode", [projectModeExisting, projectModeNew]),
    unitNumber: z.string().trim().min(1).max(40),
    ownerPartyId: z.string().uuid(),
    salesDate: z.string().datetime(),
    purpose: z.enum(["rent", "own_stay"]),
    purchasePrice: z.number().min(0),
    bedrooms: z.number().int().min(-1).max(10),
    bathrooms: z.number().int().min(1).max(10),
    parkingLots: z.number().int().min(0).max(20),
    expectedRental: z.number().min(0).optional(),
    renovation: renovationBlock.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.purpose === "rent" && (data.expectedRental == null || data.expectedRental <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expectedRental is required when purpose='rent'.",
        path: ["expectedRental"],
      });
    }
  });

export type CreateSalesEntryInput = z.infer<typeof createSalesEntrySchema>;
