// Manual invoice-create input (R11). The accountant raises manual invoices here.
// Money is a 2-dp decimal STRING. family/docType/counterparty are DERIVED
// server-side from each line's ChargeCategory — never sent by the client.
import { z } from "zod";

const amountString = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string with up to 2dp");

export const manualInvoiceLineInput = z.object({
  description: z.string().min(1).max(200),
  categoryId: z.string().uuid(),
  amount: amountString,
});

export const manualInvoiceInput = z.object({
  counterpartyType: z.enum(["tenant", "owner"]),
  partyId: z.string().uuid(),
  apartmentId: z.string().uuid().optional(),
  /** "YYYY-MM". */
  billingMonth: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
  lines: z.array(manualInvoiceLineInput).min(1).max(50),
});
export type ManualInvoiceInput = z.infer<typeof manualInvoiceInput>;
export type ManualInvoiceLineInput = z.infer<typeof manualInvoiceLineInput>;
