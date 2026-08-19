import { Hono } from "hono";
import { z } from "zod";
import { paginationSchema, portalPaySchema, fpxInitiateSchema } from "@kason/shared";
import type { PortalEnv } from "../auth/portal.auth.types";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { listPayments, getPaymentReceipt, listPayableCharges } from "./portal.payments.repository";
import { submitMultiPaymentService } from "./portal.payments.service";
import { initiateFpxPaymentService } from "./fpx-initiate.service";
import { mintPaymentSlipKey, SLIP_CONTENT_TYPES } from "./slip-storage";
import { createSignedUploadUrl } from "../../../lib/storage";
import { formatZodError } from "../../../lib/zod-error-mapper";

const portalPaymentsRoutes = new Hono<PortalEnv>();

portalPaymentsRoutes.get("/", async (c) => {
  const session = c.get("session");
  const parsed = paginationSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid pagination" }, 400);
  const result = await listPayments(
    { partyId: session.partyId, orgId: session.orgId },
    parsed.data.page, parsed.data.limit,
  );
  return c.json(result);
});

// Must be declared BEFORE /:id/receipt so Hono doesn't match "payable-charges" as :id.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multiPayGate = async (c: any, next: any) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_MULTI_PAY")) return c.json({ error: "not_found" }, 404);
  await next();
};

portalPaymentsRoutes.get("/payable-charges", multiPayGate, async (c) => {
  const session = c.get("session");
  const parsed = paginationSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid pagination" }, 400);
  const result = await listPayableCharges(
    { partyId: session.partyId, orgId: session.orgId },
    parsed.data.page,
    parsed.data.limit,
  );
  return c.json(result);
});

// Transfer-slip upload. Mirrors the portal's established signed-URL pattern
// (tenant-ic, renovation claims, avatars): the API mints an org+party-scoped key
// and a short-lived signed URL, the browser PUTs the file straight to storage,
// then POST /pay submits the returned key. Declared BEFORE /:id/receipt so Hono
// doesn't match "slip-upload-url" as :id.
//
// The key is minted SERVER-side and re-verified on submit — a client that
// invents its own key gets 403 there (see submitMultiPaymentService).
const slipUploadUrlSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.enum(SLIP_CONTENT_TYPES),
});

portalPaymentsRoutes.post("/slip-upload-url", multiPayGate, async (c) => {
  const session = c.get("session");
  const parsed = slipUploadUrlSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const storageKey = mintPaymentSlipKey(session.orgId, session.partyId, parsed.data.filename);
  try {
    // Forward Supabase's full signed-upload contract — method and headers — so
    // the browser can upload directly. Dropping these caused PUT 404 in prod
    // on the tenant-IC path; this route carries the same shape deliberately.
    const signed = await createSignedUploadUrl({ storageKey, contentType: parsed.data.contentType });
    return c.json({
      data: {
        storageKey,
        uploadUrl: signed.uploadUrl,
        method: signed.method,
        headers: signed.headers,
      },
    });
  } catch {
    // Never leak the storage SDK's error to a tenant.
    return c.json({ error: "Could not start the upload. Please try again." }, 502);
  }
});

portalPaymentsRoutes.post("/pay", multiPayGate, async (c) => {
  const session = c.get("session");
  const parsed = portalPaySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await submitMultiPaymentService({ partyId: session.partyId, orgId: session.orgId, userId: session.userId }, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 409);
  return c.json(result.data, result.status as 200 | 201);
});

// FPX initiate is gated by BOTH multi-pay AND fpx flags (the basket machinery is
// multi-pay; the gateway is fpx) — 404 if either is off. Declared BEFORE
// /:id/receipt so Hono doesn't match "fpx" as :id.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fpxGate = async (c: any, next: any) => {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_MULTI_PAY") || !isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
};

portalPaymentsRoutes.post("/fpx/initiate", fpxGate, async (c) => {
  const session = c.get("session");
  const parsed = fpxInitiateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "payments" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await initiateFpxPaymentService(
    { partyId: session.partyId, orgId: session.orgId, userId: session.userId },
    parsed.data,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409);
  return c.json(result.data, result.status as 200);
});

portalPaymentsRoutes.get("/:id/receipt", async (c) => {
  const session = c.get("session");
  const payment = await getPaymentReceipt(
    { partyId: session.partyId, orgId: session.orgId },
    c.req.param("id"),
  );
  if (!payment) return c.json({ error: "Payment not found" }, 404);
  return c.json({ data: payment });
});

export { portalPaymentsRoutes };
