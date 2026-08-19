/**
 * Bill-attachment ROUTES integration test (RUN_INTEGRATION=1).
 *
 * Exercises the real meter routes (attach/list/detach) end-to-end — real
 * services, real repo, real local Postgres — mounted on an in-process Hono
 * app the same way routes.test.ts's makeApp() does (a session middleware
 * that bypasses real JWT auth; this suite is about the route→service→repo
 * wiring, not the token format). Only Supabase Storage is mocked (mirrors
 * owner-expense-proof.service.test.ts's approach) so no real bucket is
 * required; the DB is real.
 *
 * Run:
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run src/modules/meter/__tests__/attachment.routes.integration.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}?token=t`),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

import { deleteObject, putObject } from "../../../lib/storage";
import { meterRoutes } from "../routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix ba88)
const ORG = "ba880000-0000-4000-8000-000000000001";
const USER = "ba880000-0000-4000-8000-000000000002";
const PROP = "ba880000-0000-4000-8000-000000000003";
const APT = "ba880000-0000-4000-8000-000000000004";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.unitUtilityBillAttachment.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBill(status: "draft" | "charged" | "void" = "draft") {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Attach Routes Org", slug: "attach-routes-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "attach-routes@example.test", fullName: "Attach Routes Manager", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  const bill = await db.unitUtilityBill.create({ data: { organizationId: ORG, apartmentId: APT, periodMonth: new Date("2026-06-01"), billingMode: "whole", tnbTotal: "10.00", createdBy: USER, status } });
  return { billId: bill.id };
}

const MANAGER: SessionPayload = { userId: USER, orgId: ORG, role: "manager", userType: "operator" };
const EDITOR: SessionPayload = { userId: USER, orgId: ORG, role: "editor", userType: "operator" };

function makeApp(session: SessionPayload = MANAGER) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", meterRoutes);
  return app;
}

function pdfForm(filename = "TNB.pdf") {
  const form = new FormData();
  form.append("files", new File([new Uint8Array([1, 2, 3])], filename, { type: "application/pdf" }));
  return form;
}

dn("bill attachment routes (integration)", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    vi.clearAllMocks();
    await cleanup();
  });

  it("attaches, lists, and detaches a draft-bill file (no-orphan storage delete)", async () => {
    const { billId } = await seedBill();
    const app = makeApp();

    const post = await app.request(`/utility-bills/${billId}/attachments`, { method: "POST", body: pdfForm() });
    expect(post.status).toBe(201);
    const rows = (await post.json()) as { id: string; filename: string; url: string; createdAt: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("TNB.pdf");
    expect(rows[0].url).toContain("signed.example");
    expect(putObject).toHaveBeenCalledTimes(1);

    const get = await app.request(`/utility-bills/${billId}/attachments`);
    expect(get.status).toBe(200);
    const listBody = (await get.json()) as { data: { id: string; filename: string }[] };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].id).toBe(rows[0].id);

    const del = await app.request(`/utility-bills/${billId}/attachments/${rows[0].id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(deleteObject).toHaveBeenCalledTimes(1); // no-orphan: storage object deleted on detach

    const getAfter = await app.request(`/utility-bills/${billId}/attachments`);
    expect(((await getAfter.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("rejects attaching to a charged bill", async () => {
    const { billId } = await seedBill("charged");
    const app = makeApp();

    const post = await app.request(`/utility-bills/${billId}/attachments`, { method: "POST", body: pdfForm() });
    expect(post.status).toBe(409);
    expect(await post.json()).toEqual({ error: "BILL_NOT_EDITABLE" });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("rejects detaching an attachment once its bill is charged (no post-charge orphaning)", async () => {
    const { billId } = await seedBill(); // draft — attach must succeed first
    const app = makeApp();

    const post = await app.request(`/utility-bills/${billId}/attachments`, { method: "POST", body: pdfForm() });
    expect(post.status).toBe(201);
    const [row] = (await post.json()) as { id: string }[];

    // Flip the bill to charged directly — this test is about the detach
    // guard, not the full charge pipeline (which needs a reconciled reading/
    // tenancy setup out of scope here).
    await getDb().unitUtilityBill.update({ where: { id: billId }, data: { status: "charged" } });

    const del = await app.request(`/utility-bills/${billId}/attachments/${row.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(await del.json()).toEqual({ error: "BILL_NOT_EDITABLE" });
    expect(deleteObject).not.toHaveBeenCalled(); // guard blocks BEFORE the storage delete runs

    // The attachment must still be listable — the (rejected) detach left it alone.
    const get = await app.request(`/utility-bills/${billId}/attachments`);
    expect(((await get.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("404s attaching to an unknown bill", async () => {
    const app = makeApp();
    const unknownBillId = "00000000-0000-4000-8000-000000000000";
    const post = await app.request(`/utility-bills/${unknownBillId}/attachments`, { method: "POST", body: pdfForm() });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: "BILL_NOT_FOUND" });
  });

  it("403s a non-manager attach (editor is below manager for attach)", async () => {
    const { billId } = await seedBill();
    const post = await makeApp(EDITOR).request(`/utility-bills/${billId}/attachments`, { method: "POST", body: pdfForm() });
    expect(post.status).toBe(403);
  });

  it("editor CAN list attachments (list is gated at editor, the floor tier)", async () => {
    const { billId } = await seedBill();
    const get = await makeApp(EDITOR).request(`/utility-bills/${billId}/attachments`);
    expect(get.status).toBe(200);
  });

  it("403s a non-manager detach (editor is below manager for detach)", async () => {
    const { billId } = await seedBill();
    const post = await makeApp().request(`/utility-bills/${billId}/attachments`, { method: "POST", body: pdfForm() });
    const [row] = (await post.json()) as { id: string }[];

    const del = await makeApp(EDITOR).request(`/utility-bills/${billId}/attachments/${row.id}`, { method: "DELETE" });
    expect(del.status).toBe(403);
  });
});
