/**
 * Portal owner-ledger routes — OWN-DATA-ONLY.
 *
 * All routes require portalUserTypeGuard("owner") (applied in portal/index.ts)
 * and the ENABLE_PHASE2_OWNER_BILLING flag.
 *
 * Endpoints:
 *   GET /owner-ledger?fromMonth&toMonth&propertyId
 *   GET /owner-ledger/tax-summary?fromMonth&toMonth&propertyId
 *   GET /owner-ledger/properties/:id
 */
import { Hono } from "hono";
import { ownerLedgerRangeQuery } from "@kason/shared";
import { summarizeOwnerPeriod, summarizeTax } from "@kason/shared";
import type { PortalEnv } from "../auth/portal.auth.types";
import { ownerLedgerFlagGate } from "../../owner-ledger/owner-ledger.gate";
import { formatZodError } from "../../../lib/zod-error-mapper";
import { resolveOwnerBalance } from "../../owner-ledger/owner-ledger.repository";
import {
  getOwnerLedgerRows,
  getOwnerPropertyView,
} from "./portal.owner-ledger.repository";

const TAX_DISCLAIMER =
  "This summary is prepared based on rental income and expenses recorded in the system. Please consult your tax agent for final tax filing and tax deductibility.";

const portalOwnerLedgerRoutes = new Hono<PortalEnv>();

// Flag gate: all /owner-ledger/* routes 404 when ENABLE_PHASE2_OWNER_BILLING is dark.
portalOwnerLedgerRoutes.use("*", ownerLedgerFlagGate);

// ─── GET /owner-ledger ────────────────────────────────────────────────────────

portalOwnerLedgerRoutes.get("/", async (c) => {
  const session = c.get("session");

  // Validate query params but always override ownerPartyId with session.partyId.
  const rawQuery = {
    fromMonth: c.req.query("fromMonth"),
    toMonth: c.req.query("toMonth"),
    propertyId: c.req.query("propertyId") || undefined,
    // Include ownerPartyId so Zod doesn't reject unknown fields, but we discard it.
    ownerPartyId: session.partyId,
  };

  const parsed = ownerLedgerRangeQuery.safeParse(rawQuery);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "owner-ledger" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  // CRITICAL: ownerPartyId from query is IGNORED — always use session.partyId.
  const { fromMonth, toMonth, propertyId } = parsed.data;

  const { rows, lines } = await getOwnerLedgerRows(
    session.orgId,
    session.partyId,
    fromMonth ?? "",
    toMonth ?? "",
    propertyId,
  );

  const summary = summarizeOwnerPeriod(lines);

  const balance = await resolveOwnerBalance(
    session.orgId,
    session.partyId,
    fromMonth ?? undefined,
    toMonth ?? undefined,
  );

  return c.json({ data: { rows, summary: { ...summary, broughtForward: balance.broughtForward, carriedForward: balance.carriedForward } } });
});

// ─── GET /owner-ledger/tax-summary ───────────────────────────────────────────

portalOwnerLedgerRoutes.get("/tax-summary", async (c) => {
  const session = c.get("session");

  const rawQuery = {
    fromMonth: c.req.query("fromMonth"),
    toMonth: c.req.query("toMonth"),
    propertyId: c.req.query("propertyId") || undefined,
    ownerPartyId: session.partyId,
  };

  const parsed = ownerLedgerRangeQuery.safeParse(rawQuery);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "owner-ledger" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const { fromMonth, toMonth, propertyId } = parsed.data;

  const { lines } = await getOwnerLedgerRows(
    session.orgId,
    session.partyId,
    fromMonth ?? "",
    toMonth ?? "",
    propertyId,
  );

  const taxSummary = summarizeTax(lines);

  return c.json({ data: { ...taxSummary, disclaimer: TAX_DISCLAIMER } });
});

// ─── GET /owner-ledger/properties/:id ────────────────────────────────────────

portalOwnerLedgerRoutes.get("/properties/:id", async (c) => {
  const session = c.get("session");
  const propertyId = c.req.param("id");

  const propertyView = await getOwnerPropertyView(
    session.orgId,
    session.partyId,
    propertyId,
  );

  if (!propertyView) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json({ data: propertyView });
});

export { portalOwnerLedgerRoutes };
