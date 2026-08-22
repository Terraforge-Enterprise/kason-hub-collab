import { Hono } from "hono";
import { z } from "zod";
import type { SessionPayload } from "../../lib/auth";
import { requirePermission, userHasPermission } from "../../middleware/require-permission";
import { categorizeTransaction, createAccount, importTransactions, previewImport, listAccounts, listMatchCandidates, listTransactions, reconciliationSummary, type ReconActor } from "./service";

const routes = new Hono<{ Variables: { session: SessionPayload } }>();
routes.use("*", requirePermission("bank.read"));

function actor(c: { get(name: "session"): SessionPayload }): ReconActor {
  const session = c.get("session");
  return { orgId: session.orgId, userId: session.userId, role: session.role };
}

const accountSchema = z.object({ bankName: z.enum(["Maybank", "Hong Leong Bank", "Other"]), nickname: z.string().trim().min(1).max(80), maskedAccountNumber: z.string().trim().max(40).optional() });
const transactionSchema = z.object({ transactionDate: z.string().date(), description: z.string().trim().min(1).max(500), reference: z.string().trim().max(200).optional(), debit: z.number().nonnegative().optional(), credit: z.number().nonnegative().optional(), balance: z.number().optional() }).refine((row) => !((row.debit ?? 0) > 0 && (row.credit ?? 0) > 0), "A transaction cannot be both debit and credit");
const importSchema = z.object({ accountId: z.string().uuid(), source: z.enum(["manual", "paste", "csv"]), transactions: z.array(transactionSchema).min(1).max(5000) });
const moneyString = z.string().regex(/^\d+(\.\d{1,2})?$/).refine((value) => Number(value) > 0);
const categorizeSchema = z.object({ apartmentId: z.string().uuid().nullable().optional(), responsibility: z.enum(["tenant", "owner", "company", "pending"]).nullable().optional(), collectionCategory: z.enum(["rental", "deposit", "tenant_expense", "owner_payment", "management_fee", "other", "pending"]).nullable().optional(), transactionCategory: z.enum(["non_operational_transfer", "internal_bank_transfer"]).nullable().optional(), counterpartTransactionId: z.string().uuid().optional(), destinationAccount: z.string().trim().min(1).max(160).nullable().optional(), transferPurpose: z.enum(["payroll_funding", "head_office_funding", "reserve_transfer", "tax_funding", "other"]).nullable().optional(), gridExpenseId: z.string().uuid().nullable().optional(), matchNotes: z.string().max(1000).optional(), allocations: z.array(z.object({ chargeId: z.string().uuid(), allocatedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/) })).max(50).optional(), costAllocations: z.array(z.object({ targetType: z.enum(["grid_expense", "employee_claim"]), targetId: z.string().uuid(), allocatedAmount: moneyString })).min(1).max(100).optional(), unitCostItems: z.array(z.object({ apartmentId: z.string().uuid(), billingMonth: z.string().regex(/^\d{4}-\d{2}$/), bearer: z.enum(["owner", "tenant"]), costType: z.enum(["tnb", "water", "wifi", "cleaning", "maintenance", "recurring", "repair", "other"]), description: z.string().trim().min(1).max(300), amount: moneyString, withSST: z.boolean().default(false) })).min(1).max(100).optional() });

routes.get("/accounts", async (c) => c.json({ data: await listAccounts(actor(c)) }));
routes.post("/accounts", requirePermission("bank.manage_accounts"), async (c) => { const parsed = accountSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error: "invalid_account", details: parsed.error.flatten() }, 400); return c.json({ data: await createAccount(actor(c), parsed.data) }, 201); });
routes.post("/imports", requirePermission("bank.import"), async (c) => { const parsed = importSchema.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error: "invalid_import", details: parsed.error.flatten() }, 400); try { return c.json({ data: await importTransactions(actor(c), parsed.data) }, 201); } catch (error) { if (error instanceof Error && error.message === "ACCOUNT_NOT_FOUND") return c.json({ error: "account_not_found" }, 404); if (error instanceof Error && error.message === "IMPORT_VERIFICATION_FAILED") return c.json({ error: "import_verification_failed" }, 409); throw error; } });
routes.post("/imports/preview", requirePermission("bank.import"), async (c) => { const parsed = importSchema.pick({ accountId: true, transactions: true }).safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error: "invalid_import_preview", details: parsed.error.flatten() }, 400); try { return c.json({ data: await previewImport(actor(c), parsed.data) }); } catch (error) { if (error instanceof Error && error.message === "ACCOUNT_NOT_FOUND") return c.json({ error: "account_not_found" }, 404); throw error; } });
routes.get("/transactions", async (c) => c.json({ data: await listTransactions(actor(c), { status: c.req.query("status"), q: c.req.query("q"), accountId: c.req.query("accountId") }) }));
routes.get("/candidates", async (c) => c.json({ data: await listMatchCandidates(actor(c)) }));
routes.get("/summary", async (c) => c.json({ data: await reconciliationSummary(actor(c)) }));
routes.patch("/transactions/:id/categorize", requirePermission("bank.categorize"), async (c) => {
  const parsed = categorizeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_categorization", details: parsed.error.flatten() }, 400);
  const session = c.get("session");
  const required = new Set<Parameters<typeof userHasPermission>[1]>();
  if (parsed.data.allocations?.length) required.add("bank.allocate_credit");
  if (parsed.data.costAllocations?.length || parsed.data.gridExpenseId) required.add("bank.allocate_debit");
  if (parsed.data.unitCostItems?.length) { required.add("bank.allocate_debit"); required.add("cost.create_from_bank"); }
  if (parsed.data.transactionCategory === "internal_bank_transfer") required.add("bank.internal_transfer");
  for (const permission of required) {
    if (!(await userHasPermission(session, permission))) return c.json({ error: "permission_forbidden", permission }, 403);
  }
  try { return c.json({ data: await categorizeTransaction(actor(c), c.req.param("id"), parsed.data) }); }
  catch (error) {
    if (error instanceof Error && ["TRANSACTION_NOT_FOUND", "EXPENSE_NOT_FOUND", "UNIT_NOT_FOUND", "TENANCY_NOT_FOUND", "INTERNAL_TRANSFER_COUNTERPART_NOT_FOUND"].includes(error.message)) return c.json({ error: error.message.toLowerCase() }, 404);
    if (error instanceof Error && ["EXPENSE_UNIT_MISMATCH", "COLLECTION_UNIT_MISMATCH", "INVALID_COLLECTION_ALLOCATIONS", "COLLECTION_ALLOCATION_MUST_EQUAL_CREDIT", "INVALID_COST_ALLOCATIONS", "COST_ALLOCATION_MUST_EQUAL_DEBIT", "COST_TARGET_NOT_FOUND", "CLAIM_NOT_APPROVED", "NON_OPERATIONAL_TRANSFER_MUST_BE_DEBIT", "NON_OPERATIONAL_TRANSFER_DETAILS_REQUIRED", "INVALID_NON_OPERATIONAL_TRANSFER", "INTERNAL_TRANSFER_COUNTERPART_REQUIRED", "INTERNAL_TRANSFER_DIFFERENT_BANK_REQUIRED", "INTERNAL_TRANSFER_AMOUNT_OR_DIRECTION_MISMATCH", "INTERNAL_TRANSFER_COUNTERPART_ALREADY_MATCHED", "INTERNAL_TRANSFER_HAS_POSTED_PAYMENT"].includes(error.message)) return c.json({ error: error.message.toLowerCase() }, 409);
    if (error instanceof Error && error.message.startsWith("PAYMENT_RECORD_FAILED:")) return c.json({ error: "payment_record_failed", detail: error.message.slice("PAYMENT_RECORD_FAILED:".length) }, 409);
    throw error;
  }
});

export { routes as bankReconciliationRoutes };
