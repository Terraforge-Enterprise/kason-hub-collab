import { Hono } from "hono";
import { getReadOnlyPrisma } from "../public-card/prisma-readonly";
import {
  fillReservationSchema,
  signReservationSchema,
  tokenParamSchema,
  uploadUrlSchema,
  markUploadedSchema,
  docKindSchema,
} from "./validation";
import { fillReservationByTokenService, signReservationByTokenService } from "./service";
import {
  requestReservationUploadUrlByToken,
  markReservationDocUploadedByToken,
  deleteReservationDocByToken,
} from "./documents.service";
import { formatZodError } from "../../lib/zod-error-mapper";
import * as repo from "./repository";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";

const MIN_LATENCY_MS = 50;

async function pad404Latency(start: number): Promise<void> {
  const elapsed = Date.now() - start;
  if (elapsed < MIN_LATENCY_MS) {
    await new Promise((r) => setTimeout(r, MIN_LATENCY_MS - elapsed));
  }
}

export const publicReservationsRoutes = new Hono();

publicReservationsRoutes.get("/:token", async (c) => {
  const start = Date.now();

  const paramParsed = tokenParamSchema.safeParse({ token: c.req.param("token") });
  if (!paramParsed.success) {
    await pad404Latency(start);
    return c.json({ error: "Not found or link no longer valid" }, 404);
  }

  const prisma = getReadOnlyPrisma();
  const r = await repo.findByTokenForPublicReadOnly(paramParsed.data.token, prisma);
  if (!r || r.status !== "pending_customer" || r.expiresAt < new Date()) {
    await pad404Latency(start);
    return c.json({ error: "Not found or link no longer valid" }, 404);
  }

  const template = await getTemplateForOrgDocType(r.organizationId, "reservation_form");

  return c.json({
    data: {
      referenceCode: r.referenceCode,
      expiresAt: r.expiresAt.toISOString(),
      property: { name: r.property.name },
      unit: { unitCode: r.unit.unitCode },
      carPark: r.carPark,
      proposedMoveIn: r.proposedMoveIn.toISOString(),
      proposedMoveOut: r.proposedMoveOut?.toISOString() ?? null,
      specialRemarks: r.specialRemarks,
      charges: {
        reservationDeposit: r.reservationDeposit.toString(),
        documentationFee: r.documentationFee.toString(),
        rentalDeposit: r.rentalDeposit.toString(),
        utilityDeposit: r.utilityDeposit.toString(),
        accessCardDeposit: r.accessCardDeposit.toString(),
      },
      applicant: {
        fullName: r.applicantFullName,
        nric: r.applicantNric,
        contact: r.applicantContact,
        email: r.applicantEmail,
        addressLine1: r.applicantAddressLine1,
        addressLine2: r.applicantAddressLine2,
        city: r.applicantCity,
        postcode: r.applicantPostcode,
        state: r.applicantState,
        country: r.applicantCountry,
        nationality: r.nationality,
        occupation: r.occupation,
        monthlyIncome: r.monthlyIncome?.toString() ?? null,
        emergencyContactName: r.emergencyContactName,
        emergencyContactPhone: r.emergencyContactPhone,
        emergencyContactRelation: r.emergencyContactRelation,
      },
      documents: r.documents.map((d) => ({ kind: d.kind, filename: d.filename })),
      customTerms: r.customTerms,
      brandLogoUrl: template.logoUrl,
    },
  });
});

publicReservationsRoutes.put("/:token/fill", async (c) => {
  const paramParsed = tokenParamSchema.safeParse({ token: c.req.param("token") });
  if (!paramParsed.success) return c.json({ error: "Not found" }, 404);

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const bodyParsed = fillReservationSchema.safeParse(json);
  if (!bodyParsed.success) {
    const friendly = formatZodError(bodyParsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await fillReservationByTokenService(paramParsed.data.token, bodyParsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

publicReservationsRoutes.post("/:token/sign", async (c) => {
  const paramParsed = tokenParamSchema.safeParse({ token: c.req.param("token") });
  if (!paramParsed.success) return c.json({ error: "Not found" }, 404);

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const bodyParsed = signReservationSchema.safeParse(json);
  if (!bodyParsed.success) {
    const issues = bodyParsed.error.flatten().fieldErrors;
    if (issues.agreementTicked) return c.json({ error: "AGREEMENT_NOT_TICKED" }, 400);
    if (issues.typedName) return c.json({ error: "NAME_MISMATCH" }, 400);
    if (issues.signaturePngBase64) return c.json({ error: "EMPTY_SIGNATURE" }, 400);
    return c.json({ error: "Invalid payload", details: issues }, 400);
  }

  const ip = c.req.header("x-forwarded-for") ?? "0.0.0.0";
  const userAgent = c.req.header("user-agent") ?? "";
  const result = await signReservationByTokenService(
    paramParsed.data.token,
    bodyParsed.data,
    { ip, userAgent },
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

publicReservationsRoutes.post("/:token/upload-url", async (c) => {
  const paramParsed = tokenParamSchema.safeParse({ token: c.req.param("token") });
  if (!paramParsed.success) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = uploadUrlSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await requestReservationUploadUrlByToken(paramParsed.data.token, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data });
});

publicReservationsRoutes.post("/:token/documents/mark-uploaded", async (c) => {
  const paramParsed = tokenParamSchema.safeParse({ token: c.req.param("token") });
  if (!paramParsed.success) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = markUploadedSchema.safeParse(body);
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "reservation" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await markReservationDocUploadedByToken(paramParsed.data.token, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ data: result.data }, 201);
});

publicReservationsRoutes.delete("/:token/documents/:kind", async (c) => {
  const paramParsed = tokenParamSchema.safeParse({ token: c.req.param("token") });
  if (!paramParsed.success) return c.json({ error: "Not found" }, 404);
  const kindParsed = docKindSchema.safeParse(c.req.param("kind"));
  if (!kindParsed.success) return c.json({ error: "Invalid document kind" }, 400);
  const result = await deleteReservationDocByToken(paramParsed.data.token, kindParsed.data);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.body(null, 204);
});
