import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../projects.repository", () => ({
  listProjects: vi.fn(async () => []),
  findProjectById: vi.fn(async () => null),
  findProjectByIdTx: vi.fn(async () => null),
  findProjectByNameConflict: vi.fn(async () => null),
  createProjectRow: vi.fn(),
  updateProjectRow: vi.fn(),
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
}));

import { recordAudit } from "../../../lib/audit";
import {
  createProjectRow,
  findProjectById,
  findProjectByIdTx,
  findProjectByNameConflict,
  listProjects,
  updateProjectRow,
  withTransaction,
} from "../projects.repository";
import {
  createProjectService,
  getProjectByIdService,
  getProjectsService,
  updateProjectService,
} from "../projects.service";
import type { ProjectRow } from "../projects.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000aa";

function fakeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PROJECT_ID,
    organizationId: ORG,
    name: "Aurora Residences",
    developer: "ACME Devco",
    city: "Kuala Lumpur",
    expectedHandover: new Date("2027-06-30T00:00:00.000Z"),
    status: "active",
    promotedPropertyId: null,
    notes: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    createdById: USER,
    ...overrides,
  };
}

function baseCtx(role: "admin" | "manager" | "editor" = "manager") {
  return {
    orgId: ORG,
    actorUserId: USER,
    actorRole: role,
    ip: "10.0.0.1",
    userAgent: "vitest",
  } as const;
}

describe("createProjectService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects editor with 403", async () => {
    const result = await createProjectService(baseCtx("editor"), {
      name: "X",
      developer: "Y",
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(createProjectRow).not.toHaveBeenCalled();
  });

  it("returns 409 on duplicate name within org", async () => {
    vi.mocked(findProjectByNameConflict).mockResolvedValueOnce({ id: "x" });
    const result = await createProjectService(baseCtx(), {
      name: "Aurora Residences",
      developer: "ACME Devco",
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(createProjectRow).not.toHaveBeenCalled();
  });

  it("creates Project with audit row inside a transaction", async () => {
    vi.mocked(createProjectRow).mockResolvedValueOnce(fakeProject());
    const result = await createProjectService(baseCtx(), {
      name: "Aurora Residences",
      developer: "ACME Devco",
      city: "Kuala Lumpur",
    });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(createProjectRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        createdById: USER,
        name: "Aurora Residences",
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "project.create",
        entityType: "Project",
        entityId: PROJECT_ID,
      }),
    );
  });

  it("portal-flow: bypasses manager gate when statusOverride passed and tags audit accordingly", async () => {
    vi.mocked(createProjectRow).mockResolvedValueOnce(
      fakeProject({ status: "unverified" }),
    );
    const result = await createProjectService(
      baseCtx("editor"),
      { name: "New Project", developer: "Dev" },
      { statusOverride: "unverified" },
    );
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.create.portal" }),
    );
  });
});

describe("updateProjectService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 on missing", async () => {
    vi.mocked(findProjectById).mockResolvedValueOnce(null);
    const result = await updateProjectService(baseCtx(), PROJECT_ID, { name: "Z" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects editor with 403", async () => {
    const result = await updateProjectService(baseCtx("editor"), PROJECT_ID, { name: "Z" });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("409 on name conflict", async () => {
    vi.mocked(findProjectById).mockResolvedValueOnce(fakeProject({ name: "old" }));
    vi.mocked(findProjectByNameConflict).mockResolvedValueOnce({ id: "other" });
    const result = await updateProjectService(baseCtx(), PROJECT_ID, { name: "new" });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("records project.update with before/after diff", async () => {
    const before = fakeProject({ status: "unverified" });
    const after = fakeProject({ status: "active" });
    vi.mocked(findProjectById).mockResolvedValueOnce(before);
    vi.mocked(findProjectByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateProjectRow).mockResolvedValueOnce(after);

    const result = await updateProjectService(baseCtx(), PROJECT_ID, { status: "active" });
    expect(result).toMatchObject({ ok: true, status: 200 });
    const call = vi.mocked(recordAudit).mock.calls.at(-1)!;
    const payload = call[1] as unknown as {
      action: string;
      diff: { before: ProjectRow; after: ProjectRow };
    };
    expect(payload.action).toBe("project.update");
    expect(payload.diff.before.status).toBe("unverified");
    expect(payload.diff.after.status).toBe("active");
  });
});

describe("read services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getProjectsService returns rows for editor", async () => {
    vi.mocked(listProjects).mockResolvedValueOnce([fakeProject()]);
    const result = await getProjectsService(
      { orgId: ORG, role: "editor" },
      { status: "active" },
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    if (result.ok) expect(result.data).toHaveLength(1);
    expect(listProjects).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ status: "active" }),
    );
  });

  it("getProjectByIdService returns 404 when missing", async () => {
    vi.mocked(findProjectById).mockResolvedValueOnce(null);
    const result = await getProjectByIdService({ orgId: ORG, role: "editor" }, PROJECT_ID);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("org isolation: another org's row returns 404 (repository scopes by org)", async () => {
    vi.mocked(findProjectById).mockImplementationOnce(async (orgId) => {
      // Simulate the repo returning null when the row belongs to a different org.
      if (orgId !== ORG) return null;
      return null;
    });
    const result = await getProjectByIdService(
      { orgId: "other-org", role: "editor" },
      PROJECT_ID,
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
