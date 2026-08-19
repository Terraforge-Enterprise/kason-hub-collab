import { describe, it, expect, vi, beforeEach } from "vitest";

// getDb().$transaction must run the callback with a stub tx so the in-tx
// repo write + recordAudit execute. Keep the real `Prisma` export so the
// service's `instanceof Prisma.PrismaClientKnownRequestError` checks work.
const txStub = {} as unknown;
vi.mock("@kason/db", async () => {
  const actual = await vi.importActual<typeof import("@kason/db")>("@kason/db");
  return {
    ...actual,
    getDb: () => ({
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txStub)),
    }),
  };
});

vi.mock("../../../../lib/audit", () => ({ recordAudit: vi.fn() }));

vi.mock("../work-categories.repository", () => ({
  createWorkCategoryRow: vi.fn(),
  findWorkCategoryById: vi.fn(),
  getWorkCategoryUsageRepo: vi.fn(),
  listWorkCategoriesRepo: vi.fn(),
  updateWorkCategoryRow: vi.fn(),
  deleteWorkCategoryRow: vi.fn(),
}));

import {
  createWorkCategoryService,
  updateWorkCategoryService,
  deleteWorkCategoryService,
  getWorkCategoryUsageService,
} from "../work-categories.service";
import * as repo from "../work-categories.repository";
import { recordAudit } from "../../../../lib/audit";

const ORG = "org-1";
const CTX = { orgId: ORG, actorUserId: "u1", actorRole: "manager" as const, ip: "1.2.3.4", userAgent: "ua" };
const ROW = {
  id: "c1", organizationId: ORG, name: "Roofing", sortOrder: 12, isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};
beforeEach(() => vi.clearAllMocks());

it("creates a category and audits in-tx", async () => {
  vi.mocked(repo.createWorkCategoryRow).mockResolvedValue(ROW);
  const res = await createWorkCategoryService(CTX, { name: "Roofing", sortOrder: 12 });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.data.name).toBe("Roofing");
  expect(vi.mocked(recordAudit)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({
    action: "inventory.workcategory.create", entityType: "WorkCategory", entityId: "c1",
  });
});

it("updates a category and audits in-tx", async () => {
  vi.mocked(repo.updateWorkCategoryRow).mockResolvedValue({ ...ROW, name: "Roof" });
  const res = await updateWorkCategoryService(CTX, "c1", { name: "Roof" });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.data.name).toBe("Roof");
  expect(vi.mocked(recordAudit)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({ action: "inventory.workcategory.update" });
});

it("update returns 404 (and does NOT audit) when the row is missing/cross-org", async () => {
  vi.mocked(repo.updateWorkCategoryRow).mockResolvedValue(null);
  const res = await updateWorkCategoryService(CTX, "missing", { name: "x" });
  expect(res).toMatchObject({ ok: false, status: 404 });
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});

it("deletes an UNUSED category and audits in-tx", async () => {
  vi.mocked(repo.findWorkCategoryById).mockResolvedValue(ROW);
  vi.mocked(repo.getWorkCategoryUsageRepo).mockResolvedValue({ ticketCount: 0, taskCount: 0 });
  const res = await deleteWorkCategoryService(CTX, "c1");
  expect(res).toMatchObject({ ok: true, data: { deleted: true } });
  expect(vi.mocked(repo.deleteWorkCategoryRow)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordAudit)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({ action: "inventory.workcategory.delete" });
});

it("blocks delete of a category IN USE with 409 (no delete, no audit)", async () => {
  vi.mocked(repo.findWorkCategoryById).mockResolvedValue(ROW);
  vi.mocked(repo.getWorkCategoryUsageRepo).mockResolvedValue({ ticketCount: 3, taskCount: 1 });
  const res = await deleteWorkCategoryService(CTX, "c1");
  expect(res).toMatchObject({ ok: false, status: 409, error: { code: "category_in_use" } });
  expect(vi.mocked(repo.deleteWorkCategoryRow)).not.toHaveBeenCalled();
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});

it("delete returns 404 when the row is missing/cross-org", async () => {
  vi.mocked(repo.findWorkCategoryById).mockResolvedValue(null);
  const res = await deleteWorkCategoryService(CTX, "missing");
  expect(res).toMatchObject({ ok: false, status: 404 });
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});

it("usage counts tickets + tasks by category name", async () => {
  vi.mocked(repo.findWorkCategoryById).mockResolvedValue({ ...ROW, name: "Plumbing" });
  vi.mocked(repo.getWorkCategoryUsageRepo).mockResolvedValue({ ticketCount: 3, taskCount: 2 });
  const res = await getWorkCategoryUsageService(ORG, "c1");
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.data).toEqual({ ticketCount: 3, taskCount: 2 });
});
