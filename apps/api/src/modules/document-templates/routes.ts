// apps/api/src/modules/document-templates/routes.ts

import { Hono } from "hono";
import { docTypeParamSchema, updateTemplateBodySchema } from "./validation";
import {
  listTemplatesService,
  updateTemplateService,
  uploadLogoService,
} from "./service";
import { formatZodError } from "../../lib/zod-error-mapper";

type Session = { orgId: string; role: string; userId: string };

const ALLOWED_LOGO_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);
const MAX_LOGO_BYTES = 2_000_000;

export const documentTemplatesRoutes = new Hono<{ Variables: { session: Session } }>();

documentTemplatesRoutes.get("/", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return c.json({ error: "Admin only" }, 403);
  const data = await listTemplatesService(session.orgId);
  return c.json({ data });
});

documentTemplatesRoutes.put("/:docType", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return c.json({ error: "Admin only" }, 403);

  const paramParsed = docTypeParamSchema.safeParse({ docType: c.req.param("docType") });
  if (!paramParsed.success) {
    const friendly = formatZodError(paramParsed.error, { domain: "document-templates" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const bodyParsed = updateTemplateBodySchema.safeParse(json);
  if (!bodyParsed.success) {
    const friendly = formatZodError(bodyParsed.error, { domain: "document-templates" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const updated = await updateTemplateService(
    session.orgId,
    paramParsed.data.docType,
    bodyParsed.data,
  );
  return c.json({ data: updated });
});

// Proxy upload: client POSTs the raw file as multipart/form-data, the API
// validates, strips white background, and persists to Supabase Storage in
// one round-trip. The returned storageKey is then handed to PUT /:docType
// to save against the DocumentTemplate row.
documentTemplatesRoutes.post("/:docType/logo", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return c.json({ error: "Admin only" }, 403);

  const paramParsed = docTypeParamSchema.safeParse({ docType: c.req.param("docType") });
  if (!paramParsed.success) {
    const friendly = formatZodError(paramParsed.error, { domain: "document-templates" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const formData = await c.req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  if (!ALLOWED_LOGO_MIME.has(file.type)) {
    return c.json(
      { error: `Unsupported logo MIME — accepts ${[...ALLOWED_LOGO_MIME].join(", ")}` },
      400,
    );
  }
  if (file.size > MAX_LOGO_BYTES) {
    return c.json({ error: "Logo must be 2 MB or smaller" }, 400);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const result = await uploadLogoService(session.orgId, paramParsed.data.docType, {
    buf,
    contentType: file.type,
  });
  return c.json({ data: result });
});
