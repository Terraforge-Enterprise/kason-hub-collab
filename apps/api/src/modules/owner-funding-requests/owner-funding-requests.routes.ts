// apps/api/src/modules/owner-funding-requests/owner-funding-requests.routes.ts
// Accounting-document redesign P7, reshaped (2026-07-23) — Owner Funding Request:
// POST /api/owner-funding-requests (create a DELIBERATE admin ask) + GET (list an
// owner's requests + a read-only current-balance display helper). Thin plumbing:
// flag-gate (canonical 404 while ENABLE_OWNER_FUNDING_REQUEST is dark, BEFORE auth
// — owner-remittance.routes.ts:32-35 / expenses.routes.ts:20-23 precedent) →
// requireRole(editor) → zod parse → service → forward the service's {status,code}.
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { ownerFundingRequestInput } from "@kason/shared";
import type { SessionPayload } from "../../lib/auth";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { formatZodError } from "../../lib/zod-error-mapper";
import { requireRole } from "../../middleware/require-role";
import { getActorHeaders } from "../../lib/actor-ctx";
import {
  createOwnerFundingRequestService,
  listOwnerFundingRequestsService,
  OwnerFundingRequestError,
  type OwnerFundingRequestActorCtx,
} from "./owner-funding-requests.service";

const ownerFundingRequestsRoutes = new Hono<{ Variables: { session: SessionPayload } }>();

// Flag gate FIRST: every /api/owner-funding-requests route 404s (canonical
// "not_found") while ENABLE_OWNER_FUNDING_REQUEST is dark, BEFORE any
// auth/role check runs (owner-remittance.routes.ts / expenses.routes.ts precedent).
ownerFundingRequestsRoutes.use("*", async (c, next) => {
  if (!isPhase2FlagEnabled("ENABLE_OWNER_FUNDING_REQUEST")) return c.json({ error: "not_found" }, 404);
  await next();
});

type OwnerFundingRequestsCtx = Context<{ Variables: { session: SessionPayload } }>;

function actor(c: OwnerFundingRequestsCtx): OwnerFundingRequestActorCtx {
  const session = c.get("session");
  const { ip, userAgent } = getActorHeaders(c);
  return { orgId: session.orgId, actorUserId: session.userId, actorRole: session.role, ip, userAgent };
}

const ownerPartyIdQuerySchema = z.string().uuid();

// POST /api/owner-funding-requests — the admin's deliberate ask. requireRole
// mirrors expenses.routes.ts (P3 precedent): this is an internal accounting
// action, same tier as recording a supplier expense.
ownerFundingRequestsRoutes.post("/", requireRole("editor"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400);
  const parsed = ownerFundingRequestInput.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error);
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  try {
    const data = await createOwnerFundingRequestService(actor(c), parsed.data);
    return c.json({ data }, 201);
  } catch (e) {
    if (e instanceof OwnerFundingRequestError) return c.json({ error: e.code }, e.status as 400 | 500);
    throw e;
  }
});

// GET /api/owner-funding-requests?ownerPartyId=<uuid> — that owner's requests
// (org-scoped) + a read-only current-balance display helper (no math change).
// Same requireRole tier as POST — this module has no separate write/read split
// (mirrors owner-remittance's GET, which also shares its write gate).
ownerFundingRequestsRoutes.get("/", requireRole("editor"), async (c) => {
  const raw = c.req.query("ownerPartyId");
  const parsed = ownerPartyIdQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "INVALID_OWNER_PARTY_ID" }, 400);
  }
  const data = await listOwnerFundingRequestsService(actor(c), parsed.data);
  return c.json({ data });
});

export { ownerFundingRequestsRoutes };
