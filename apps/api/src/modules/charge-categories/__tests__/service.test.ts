import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";

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

vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));

vi.mock("../repository", () => ({
  listChargeCategoriesRepo: vi.fn(),
  findChargeCategoryByIdRepo: vi.fn(),
  createChargeCategoryRow: vi.fn(),
  guardedUpdateChargeCategory: vi.fn(),
  deactivateChargeCategoryRow: vi.fn(),
  listDocumentSeriesRepo: vi.fn(),
  findDocumentSeriesByIdRepo: vi.fn(),
  guardedUpdateDocumentSeries: vi.fn(),
}));

import {
  createChargeCategoryService,
  deactivateChargeCategoryService,
  updateChargeCategoryService,
  updateDocumentSeriesService,
} from "../service";
import * as repo from "../repository";
import { recordAudit } from "../../../lib/audit";

const CTX = { orgId: "o1", actorUserId: "u1", actorRole: "admin" as const, ip: "1.2.3.4", userAgent: "ua" };
const NOW = new Date("2026-07-02T00:00:00.000Z");
const SERIES_ROW = { id: "series-dep", organizationId: "o1", code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true, createdAt: NOW, updatedAt: NOW };
const CATEGORY_ROW = {
  id: "cat-1", organizationId: "o1", code: "rental", name: "Monthly rental",
  family: "pay_back_landlord", docType: "debit_note", seriesId: "series-dep",
  defaultSstRate: { toString: () => "0" }, eInvoiceEligible: false,
  ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 200,
  description: null, profitExpense: null, createdAt: NOW, updatedAt: NOW, series: { code: "DEP" },
};

beforeEach(() => vi.clearAllMocks());

it("create validates the series belongs to the org, creates + audits in-tx, returns the DTO", async () => {
  vi.mocked(repo.findDocumentSeriesByIdRepo).mockResolvedValue(SERIES_ROW);
  vi.mocked(repo.createChargeCategoryRow).mockResolvedValue({ ...CATEGORY_ROW, isSystem: false, code: "misc_fee", name: "Misc fee" });
  const res = await createChargeCategoryService(CTX, { code: "misc_fee", name: "Misc fee", family: "tenant_income", docType: "invoice", seriesId: "series-dep" });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.data.seriesCode).toBe("DEP");
    expect(res.data.defaultSstRate).toBe("0");
    expect(res.data.updatedAt).toBe(NOW.toISOString());
  }
  expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({ action: "billing.chargecategory.create", entityType: "ChargeCategory" });
});

it("create with a foreign/unknown seriesId → 400 SERIES_NOT_FOUND", async () => {
  vi.mocked(repo.findDocumentSeriesByIdRepo).mockResolvedValue(null);
  const res = await createChargeCategoryService(CTX, { code: "misc_fee", name: "Misc fee", family: "tenant_income", docType: "invoice", seriesId: "series-other-org" });
  expect(res).toMatchObject({ ok: false, status: 400, error: { code: "SERIES_NOT_FOUND" } });
});

it("update with a stale expectedUpdatedAt → 409 STALE_UPDATE (guarded updateMany matched 0 rows)", async () => {
  vi.mocked(repo.findChargeCategoryByIdRepo).mockResolvedValue(CATEGORY_ROW);
  vi.mocked(repo.guardedUpdateChargeCategory).mockResolvedValue(null);
  const res = await updateChargeCategoryService(CTX, "cat-1", { name: "Rental", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
  expect(res).toMatchObject({ ok: false, status: 409, error: { code: "STALE_UPDATE" } });
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});

it("deactivate on a SYSTEM category → 409 CATEGORY_IS_SYSTEM (never touches the row)", async () => {
  vi.mocked(repo.findChargeCategoryByIdRepo).mockResolvedValue(CATEGORY_ROW); // isSystem: true
  const res = await deactivateChargeCategoryService(CTX, "cat-1");
  expect(res).toMatchObject({ ok: false, status: 409, error: { code: "CATEGORY_IS_SYSTEM" } });
  expect(vi.mocked(repo.deactivateChargeCategoryRow)).not.toHaveBeenCalled();
});

it("deactivate on a non-system category succeeds + audits", async () => {
  vi.mocked(repo.findChargeCategoryByIdRepo).mockResolvedValue({ ...CATEGORY_ROW, isSystem: false });
  vi.mocked(repo.deactivateChargeCategoryRow).mockResolvedValue({ ...CATEGORY_ROW, isSystem: false, active: false });
  const res = await deactivateChargeCategoryService(CTX, "cat-1");
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.data.active).toBe(false);
  expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({ action: "billing.chargecategory.deactivate" });
});

it("series update audits and returns the DTO; stale token → 409", async () => {
  vi.mocked(repo.findDocumentSeriesByIdRepo).mockResolvedValue(SERIES_ROW);
  vi.mocked(repo.guardedUpdateDocumentSeries).mockResolvedValue({ ...SERIES_ROW, prefix: "INV" });
  const ok = await updateDocumentSeriesService(CTX, "series-dep", { prefix: "INV", expectedUpdatedAt: NOW.toISOString() });
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.data.prefix).toBe("INV");
  vi.mocked(repo.guardedUpdateDocumentSeries).mockResolvedValue(null);
  const stale = await updateDocumentSeriesService(CTX, "series-dep", { prefix: "X", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
  expect(stale).toMatchObject({ ok: false, status: 409 });
});

it("create with duplicate code/name (P2002) → 409 CATEGORY_CONFLICT", async () => {
  vi.mocked(repo.findDocumentSeriesByIdRepo).mockResolvedValue(SERIES_ROW);
  vi.mocked(repo.createChargeCategoryRow).mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`code_1_orgid`)", {
      code: "P2002",
      clientVersion: "5.0.0",
    })
  );
  const res = await createChargeCategoryService(CTX, { code: "rental", name: "Monthly rental", family: "pay_back_landlord", docType: "debit_note", seriesId: "series-dep" });
  expect(res).toMatchObject({ ok: false, status: 409, error: { code: "CATEGORY_CONFLICT" } });
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});

it("update with duplicate code/name (P2002) → 409 CATEGORY_CONFLICT", async () => {
  vi.mocked(repo.findChargeCategoryByIdRepo).mockResolvedValue(CATEGORY_ROW);
  vi.mocked(repo.guardedUpdateChargeCategory).mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`code_1_orgid`)", {
      code: "P2002",
      clientVersion: "5.0.0",
    })
  );
  const res = await updateChargeCategoryService(CTX, "cat-1", { name: "Misc fee", expectedUpdatedAt: NOW.toISOString() });
  expect(res).toMatchObject({ ok: false, status: 409, error: { code: "CATEGORY_CONFLICT" } });
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});
