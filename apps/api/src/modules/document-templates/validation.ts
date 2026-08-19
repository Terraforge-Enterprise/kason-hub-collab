// apps/api/src/modules/document-templates/validation.ts

import { z } from "zod";
import { KNOWN_DOC_TYPES } from "../../lib/document-templates/types";

export const headerFieldsSchema = z.object({
  showLogo: z.boolean(),
  showRegNo: z.boolean(),
  showSalesTaxId: z.boolean(),
  showServiceTaxId: z.boolean(),
  showAddress: z.boolean(),
  showEmail: z.boolean(),
  showContact: z.boolean(),
});

// Helper: cleared optional text inputs may arrive as "" from the client form;
// normalize to null at the validation boundary so downstream code only sees null|value.
const nullableText = (max: number) =>
  z
    .union([z.literal(""), z.string().trim().max(max)])
    .nullable()
    .transform((v) => (v === "" || v == null ? null : v));

const nullableEmail = z
  .union([z.literal(""), z.string().trim().email().max(254)])
  .nullable()
  .transform((v) => (v === "" || v == null ? null : v));

export const updateTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  refPrefix: z.string().trim().max(40),
  refSeparator: z.enum(["-", " ", "_"]),
  refPadding: z.number().int().min(1).max(10),
  refIncludeYear: z.boolean(),
  headerFields: headerFieldsSchema,
  orgRegNo: nullableText(60),
  orgSalesTaxId: nullableText(60),
  orgServiceTaxId: nullableText(60),
  orgAddressLines: z.array(z.string().trim().max(120)).max(4),
  orgEmail: nullableEmail,
  orgContact: nullableText(40),
  logoKey: nullableText(255),
});

export const docTypeParamSchema = z.object({
  docType: z.enum([...KNOWN_DOC_TYPES] as const),
});
