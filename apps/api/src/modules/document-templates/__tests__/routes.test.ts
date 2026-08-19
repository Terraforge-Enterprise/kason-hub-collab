// apps/api/src/modules/document-templates/__tests__/routes.test.ts

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { documentTemplatesRoutes } from "../routes";
import * as svc from "../service";
import { DEFAULT_HEADER_FIELDS } from "../../../lib/document-templates/types";

vi.mock("../service");

function buildApp(role: SessionPayload["role"] = "admin") {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", { orgId: "org-1", role, userId: "u-1", userType: "operator" });
    await next();
  });
  app.route("/api/admin/document-templates", documentTemplatesRoutes);
  return app;
}

describe("GET /api/admin/document-templates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the templates list", async () => {
    vi.mocked(svc.listTemplatesService).mockResolvedValue([]);
    const res = await buildApp().request("/api/admin/document-templates");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [] });
  });
});

describe("PUT /api/admin/document-templates/:docType", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 on invalid body", async () => {
    const res = await buildApp().request("/api/admin/document-templates/reservation_form", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }), // missing fields
    });
    expect(res.status).toBe(400);
  });

  it("400 on unknown docType", async () => {
    const res = await buildApp().request("/api/admin/document-templates/banana", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("200 on valid update", async () => {
    vi.mocked(svc.updateTemplateService).mockResolvedValue({
      id: "tpl-1",
      organizationId: "org-1",
      docType: "reservation_form",
      title: "X",
      refPrefix: "RES",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: { ...DEFAULT_HEADER_FIELDS },
      orgRegNo: null,
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: null,
      logoUrl: null,
      orgName: "Test Organisation",
    });

    const body = {
      title: "X",
      refPrefix: "RES",
      refSeparator: "-",
      refPadding: 5,
      refIncludeYear: false,
      headerFields: DEFAULT_HEADER_FIELDS,
      orgRegNo: null,
      orgSalesTaxId: null,
      orgServiceTaxId: null,
      orgAddressLines: [],
      orgEmail: null,
      orgContact: null,
      logoKey: null,
    };

    const res = await buildApp().request("/api/admin/document-templates/reservation_form", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/document-templates/:docType/logo", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeFormData(file: File): FormData {
    const fd = new FormData();
    fd.append("file", file);
    return fd;
  }

  it("403 for non-admin", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    const res = await buildApp("agent").request(
      "/api/admin/document-templates/reservation_form/logo",
      { method: "POST", body: makeFormData(file) },
    );
    expect(res.status).toBe(403);
  });

  it("400 on unsupported mime", async () => {
    const file = new File(["not an image"], "logo.txt", { type: "text/plain" });
    const res = await buildApp().request(
      "/api/admin/document-templates/reservation_form/logo",
      { method: "POST", body: makeFormData(file) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unsupported logo MIME/);
  });

  it("400 when file is too large", async () => {
    // 2_000_001-byte buffer to trip the size cap
    const big = new Uint8Array(2_000_001);
    const file = new File([big], "huge.png", { type: "image/png" });
    const res = await buildApp().request(
      "/api/admin/document-templates/reservation_form/logo",
      { method: "POST", body: makeFormData(file) },
    );
    expect(res.status).toBe(400);
  });

  it("400 when file field is missing", async () => {
    const res = await buildApp().request(
      "/api/admin/document-templates/reservation_form/logo",
      { method: "POST", body: new FormData() },
    );
    expect(res.status).toBe(400);
  });

  it("200 on happy path and returns the storageKey", async () => {
    vi.mocked(svc.uploadLogoService).mockResolvedValue({
      storageKey: "org-templates/org-1/reservation_form/logo-test.png",
    });
    const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    const res = await buildApp().request(
      "/api/admin/document-templates/reservation_form/logo",
      { method: "POST", body: makeFormData(file) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.storageKey).toMatch(/logo-test\.png$/);
    expect(svc.uploadLogoService).toHaveBeenCalledWith(
      "org-1",
      "reservation_form",
      expect.objectContaining({ contentType: "image/png" }),
    );
  });
});
