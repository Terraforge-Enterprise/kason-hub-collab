import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../renovation-settings.repository", () => ({
  listLabels: vi.fn(async () => []),
  findLabelById: vi.fn(async () => null),
  findLabelByIdTx: vi.fn(async () => null),
  findLabelByCategoryKeyConflict: vi.fn(async () => null),
  createLabelRow: vi.fn(),
  updateLabelRow: vi.fn(),
  deleteLabelRow: vi.fn(async () => undefined),
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
}));

import { recordAudit } from "../../../lib/audit";
import {
  createLabelRow,
  deleteLabelRow,
  findLabelByCategoryKeyConflict,
  findLabelById,
  findLabelByIdTx,
  listLabels,
  updateLabelRow,
} from "../renovation-settings.repository";
import {
  createLabelService,
  deleteLabelService,
  listLabelsService,
  updateLabelService,
} from "../renovation-settings.service";
import type {
  LabelCategory,
  SettingsLabelRow,
} from "../renovation-settings.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const LABEL_ID = "00000000-0000-0000-0000-0000000000aa";

function fakeLabel(
  overrides: Partial<SettingsLabelRow> = {},
): SettingsLabelRow {
  return {
    id: LABEL_ID,
    organizationId: ORG,
    category: "claim_status",
    key: "submitted",
    label: "Submitted",
    sortOrder: 1,
    ...overrides,
  };
}

function ctx(role: "admin" | "manager" | "editor" = "admin") {
  return {
    orgId: ORG,
    actorUserId: USER,
    actorRole: role,
    ip: "10.0.0.1",
    userAgent: "vitest",
  } as const;
}

// ─── List ───────────────────────────────────────────────────────────────────

describe("listLabelsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 200 (read-only)", async () => {
    vi.mocked(listLabels).mockResolvedValueOnce([]);
    const r = await listLabelsService(ctx("editor"));
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("scopes by orgId", async () => {
    vi.mocked(listLabels).mockResolvedValueOnce([]);
    await listLabelsService(ctx("editor"));
    expect(listLabels).toHaveBeenCalledWith(ORG);
  });

  it("groups by category and preserves repository sort order", async () => {
    // Repository contract: rows arrive pre-sorted by sortOrder ASC. The
    // service must preserve that order within each bucket.
    const rows: SettingsLabelRow[] = [
      fakeLabel({ id: "a", category: "claim_status", key: "submitted", sortOrder: 1 }),
      fakeLabel({ id: "b", category: "claim_status", key: "approved", sortOrder: 3 }),
      fakeLabel({ id: "c", category: "renovation_status", key: "not_started", sortOrder: 1 }),
      fakeLabel({ id: "d", category: "document_kind", key: "quotation", sortOrder: 1 }),
      fakeLabel({ id: "e", category: "payment_type", key: "full", sortOrder: 1 }),
    ];
    vi.mocked(listLabels).mockResolvedValueOnce(rows);
    const r = await listLabelsService(ctx("editor"));
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.claim_status.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r.data.renovation_status.map((x) => x.id)).toEqual(["c"]);
    expect(r.data.document_kind.map((x) => x.id)).toEqual(["d"]);
    expect(r.data.payment_type.map((x) => x.id)).toEqual(["e"]);
  });

  it("returns all four categories as empty arrays when no rows", async () => {
    vi.mocked(listLabels).mockResolvedValueOnce([]);
    const r = await listLabelsService(ctx("editor"));
    if (!r.ok) throw new Error("expected ok");
    expect(r.data).toEqual({
      claim_status: [],
      renovation_status: [],
      document_kind: [],
      payment_type: [],
    });
  });

  it("ignores rows with unknown category (defensive)", async () => {
    vi.mocked(listLabels).mockResolvedValueOnce([
      fakeLabel({ category: "rogue" as unknown as LabelCategory }),
    ]);
    const r = await listLabelsService(ctx("editor"));
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.claim_status).toHaveLength(0);
    expect(r.data.renovation_status).toHaveLength(0);
    expect(r.data.document_kind).toHaveLength(0);
    expect(r.data.payment_type).toHaveLength(0);
  });
});

// ─── Create ─────────────────────────────────────────────────────────────────

describe("createLabelService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor + manager rejected (admin only)", async () => {
    const input = {
      category: "claim_status" as const,
      key: "new_status",
      label: "New",
    };
    expect(await createLabelService(ctx("editor"), input)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await createLabelService(ctx("manager"), input)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(createLabelRow).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("409 on (orgId, category, key) conflict", async () => {
    vi.mocked(findLabelByCategoryKeyConflict).mockResolvedValueOnce({ id: "x" });
    const r = await createLabelService(ctx("admin"), {
      category: "claim_status",
      key: "submitted",
      label: "Already exists",
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(createLabelRow).not.toHaveBeenCalled();
  });

  it("happy: creates row, records audit, defaults sortOrder to 0", async () => {
    vi.mocked(createLabelRow).mockResolvedValueOnce(
      fakeLabel({ key: "new_status", label: "New", sortOrder: 0 }),
    );
    const r = await createLabelService(ctx("admin"), {
      category: "claim_status",
      key: "new_status",
      label: "New",
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(createLabelRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        category: "claim_status",
        key: "new_status",
        label: "New",
        sortOrder: 0,
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "renovation.label.create",
        entityType: "SettingsLabel",
      }),
    );
  });

  it("happy: forwards explicit sortOrder", async () => {
    vi.mocked(createLabelRow).mockResolvedValueOnce(fakeLabel({ sortOrder: 5 }));
    await createLabelService(ctx("admin"), {
      category: "payment_type",
      key: "deferred",
      label: "Deferred",
      sortOrder: 5,
    });
    expect(createLabelRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sortOrder: 5 }),
    );
  });
});

// ─── Update ─────────────────────────────────────────────────────────────────

describe("updateLabelService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor + manager rejected", async () => {
    expect(
      await updateLabelService(ctx("editor"), LABEL_ID, { label: "x" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await updateLabelService(ctx("manager"), LABEL_ID, { label: "x" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(updateLabelRow).not.toHaveBeenCalled();
  });

  it("404 when not found", async () => {
    vi.mocked(findLabelById).mockResolvedValueOnce(null);
    const r = await updateLabelService(ctx("admin"), LABEL_ID, {
      label: "Renamed",
    });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(updateLabelRow).not.toHaveBeenCalled();
  });

  it("happy: updates label and records audit with before/after", async () => {
    vi.mocked(findLabelById).mockResolvedValueOnce(fakeLabel());
    vi.mocked(findLabelByIdTx).mockResolvedValueOnce(fakeLabel());
    vi.mocked(updateLabelRow).mockResolvedValueOnce(
      fakeLabel({ label: "Renamed" }),
    );
    const r = await updateLabelService(ctx("admin"), LABEL_ID, {
      label: "Renamed",
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(updateLabelRow).toHaveBeenCalledWith(
      expect.anything(),
      LABEL_ID,
      ORG,
      expect.objectContaining({ label: "Renamed" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "renovation.label.update",
        entityType: "SettingsLabel",
        entityId: LABEL_ID,
      }),
    );
  });

  it("immutable fields: schema strips category/key so service never sees them", async () => {
    // The validation layer rejects unknown keys via .strict() — verified
    // here by importing the schema directly. Service-layer guarantee: the
    // UpdateLabelInput type cannot carry `category` or `key`.
    const { updateLabelSchema } = await import("../renovation-settings.validation");
    const result = updateLabelSchema.safeParse({
      label: "Renamed",
      category: "renovation_status",
    });
    expect(result.success).toBe(false);

    const result2 = updateLabelSchema.safeParse({ key: "new_key" });
    expect(result2.success).toBe(false);

    // sanity: the legitimate shape passes
    const result3 = updateLabelSchema.safeParse({
      label: "Renamed",
      sortOrder: 5,
    });
    expect(result3.success).toBe(true);
  });
});

// ─── Delete ─────────────────────────────────────────────────────────────────

describe("deleteLabelService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor + manager rejected", async () => {
    expect(await deleteLabelService(ctx("editor"), LABEL_ID)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await deleteLabelService(ctx("manager"), LABEL_ID)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(deleteLabelRow).not.toHaveBeenCalled();
  });

  it("404 when not found", async () => {
    vi.mocked(findLabelById).mockResolvedValueOnce(null);
    const r = await deleteLabelService(ctx("admin"), LABEL_ID);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(deleteLabelRow).not.toHaveBeenCalled();
  });

  it("happy: deletes row, records audit", async () => {
    vi.mocked(findLabelById).mockResolvedValueOnce(fakeLabel());
    const r = await deleteLabelService(ctx("admin"), LABEL_ID);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(deleteLabelRow).toHaveBeenCalledWith(
      expect.anything(),
      LABEL_ID,
      ORG,
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "renovation.label.delete",
        entityType: "SettingsLabel",
        entityId: LABEL_ID,
      }),
    );
  });
});
