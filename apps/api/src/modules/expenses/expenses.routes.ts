// apps/api/src/modules/expenses/expenses.routes.ts
// Accounting-document redesign P3 — POST /api/expenses (internal Expense, EXP-).
// Thin plumbing: flag-gate (canonical 404 while ENABLE_SUPPLIER_EXPENSES is dark,
// BEFORE auth — owner-remittance.routes.ts:32-35 precedent) → requireRole(editor)
// → zod parse → createSupplierExpenseService → forward the service's {status,code}.
import { Hono } from "hono";
import type { Context } from "hono";
import { supplierExpenseInput } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requireRole } from "../../middleware/require-role";
import { getActorHeaders } from "../../lib/actor-ctx";
import { createSupplierExpenseService, ExpenseError, type ExpenseActorCtx } from "./expenses.service";

const expensesRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate FIRST: every /api/expenses route 404s while ENABLE_SUPPLIER_EXPENSES
// is dark, BEFORE any auth/role check runs (owner-remittance.routes.ts precedent).
expensesRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_SUPPLIER_EXPENSES")) return c.json({ error: "not_found" }, 404);
  await next();
});

type ExpensesCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: ExpensesCtx): ExpenseActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return { orgId: session.orgId, actorUserId: session.userId, actorRole: session.role, ip, userAgent };
}

expensesRoutes.post("/", requireRole("editor"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = supplierExpenseInput.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "billing" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  try {
    const data = await createSupplierExpenseService(actor(c), parsed.data);
    return c.json({ data }, 201);
  } catch (e) {
    if (e instanceof ExpenseError) return c.json({ error: e.code }, e.status as 400 | 500);
    throw e;
  }
});

export { expensesRoutes };
