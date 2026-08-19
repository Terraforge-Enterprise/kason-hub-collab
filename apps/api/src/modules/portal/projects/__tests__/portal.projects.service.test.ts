import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveOrCreateProjectService } from "../portal.projects.service";

const txMock = {
  project: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  projectVerificationTransition: {
    create: vi.fn(),
  },
};

beforeEach(() => {
  Object.values(txMock).forEach((m) => Object.values(m).forEach((fn: any) => fn.mockReset()));
});

describe("resolveOrCreateProjectService", () => {
  it("returns the existing project for mode='existing'", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", organizationId: "o1", status: "active" });
    const result = await resolveOrCreateProjectService(
      txMock as any,
      { mode: "existing", id: "p1" },
      { orgId: "o1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("p1");
    expect(txMock.project.create).not.toHaveBeenCalled();
  });

  it("returns 400 project_archived if existing project is archived", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", organizationId: "o1", status: "archived" });
    const result = await resolveOrCreateProjectService(
      txMock as any,
      { mode: "existing", id: "p1" },
      { orgId: "o1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("project_archived");
  });

  it("returns 404 project_not_found if existing project not in this org", async () => {
    txMock.project.findFirst.mockResolvedValue(null);
    const result = await resolveOrCreateProjectService(
      txMock as any,
      { mode: "existing", id: "p1" },
      { orgId: "o1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("project_not_found");
  });

  it("creates a new project with status=unverified for mode='new' and appends a transition", async () => {
    txMock.project.create.mockResolvedValue({ id: "newp", organizationId: "o1", status: "unverified" });
    txMock.projectVerificationTransition.create.mockResolvedValue({ id: "t1" });
    const result = await resolveOrCreateProjectService(
      txMock as any,
      { mode: "new", name: "Tower X", developer: "Dev Y" },
      { orgId: "o1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("newp");
      expect(result.data.createdNew).toBe(true);
    }
    expect(txMock.project.create).toHaveBeenCalledOnce();
    expect(txMock.projectVerificationTransition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "o1",
        projectId: "newp",
        fromStatus: null,
        toStatus: "unverified",
        changedById: "u1",
      }),
    });
  });

  it("createdNew=false for mode='existing'", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", organizationId: "o1", status: "active" });
    const result = await resolveOrCreateProjectService(
      txMock as any,
      { mode: "existing", id: "p1" },
      { orgId: "o1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.createdNew).toBe(false);
  });
});
