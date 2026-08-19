import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../../../projects/projects.repository", () => ({
  listProjects: vi.fn(async () => []),
  findProjectById: vi.fn(async () => null),
  findProjectByIdTx: vi.fn(async () => null),
  findProjectByNameConflict: vi.fn(async () => null),
  createProjectRow: vi.fn(),
  updateProjectRow: vi.fn(),
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
}));

import { recordAudit } from "../../../../lib/audit";
import {
  createProjectRow,
  findProjectByNameConflict,
} from "../../../projects/projects.repository";
import { createProjectService, getProjectsService } from "../../../projects";
import type { ProjectRow } from "../../../projects/projects.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const AGENT = "00000000-0000-0000-0000-000000000aaa";

function fakeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "proj-1",
    organizationId: ORG,
    name: "Aurora Residences",
    developer: "ACME",
    city: "KL",
    expectedHandover: null,
    status: "unverified",
    promotedPropertyId: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdById: AGENT,
    ...overrides,
  };
}

describe("portal projects flow (statusOverride='unverified')", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agent can create project with statusOverride bypassing manager+", async () => {
    vi.mocked(createProjectRow).mockResolvedValueOnce(fakeProject());
    const result = await createProjectService(
      { orgId: ORG, actorUserId: AGENT, actorRole: "editor", ip: "1", userAgent: "v" },
      { name: "Aurora Residences", developer: "ACME" },
      { statusOverride: "unverified" },
    );
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(createProjectRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ statusOverride: "unverified" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.create.portal" }),
    );
  });

  it("agent without statusOverride is blocked at editor (defence-in-depth check)", async () => {
    const result = await createProjectService(
      { orgId: ORG, actorUserId: AGENT, actorRole: "editor", ip: "1", userAgent: "v" },
      { name: "X", developer: "Y" },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(createProjectRow).not.toHaveBeenCalled();
  });

  it("conflicts on name collision", async () => {
    vi.mocked(findProjectByNameConflict).mockResolvedValueOnce({ id: "x" });
    const result = await createProjectService(
      { orgId: ORG, actorUserId: AGENT, actorRole: "editor", ip: "1", userAgent: "v" },
      { name: "Aurora Residences", developer: "ACME" },
      { statusOverride: "unverified" },
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("getProjectsService returns rows for editor (portal-friendly)", async () => {
    const result = await getProjectsService({ orgId: ORG, role: "editor" });
    expect(result).toMatchObject({ ok: true, status: 200 });
  });
});
