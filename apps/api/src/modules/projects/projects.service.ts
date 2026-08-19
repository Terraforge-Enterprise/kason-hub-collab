import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { atLeast, type AdminRole } from "../../lib/rbac";
import {
  createProjectRow,
  findProjectById,
  findProjectByIdTx,
  findProjectByNameConflict,
  listProjects,
  updateProjectRow,
  withTransaction,
} from "./projects.repository";
import type {
  CreateProjectInput,
  ListProjectsQuery,
  ProjectRow,
  UpdateProjectInput,
} from "./projects.types";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type ProjectsServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface ProjectsActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

export async function getProjectsService(
  session: { orgId: string; role: string },
  filters?: ListProjectsQuery,
): Promise<ProjectsServiceResult<ProjectRow[]>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listProjects(session.orgId, filters);
  return { ok: true, status: 200, data };
}

export async function getProjectByIdService(
  session: { orgId: string; role: string },
  id: string,
): Promise<ProjectsServiceResult<ProjectRow>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const row = await findProjectById(session.orgId, id);
  if (!row) return { ok: false, status: 404, error: "Project not found" };
  return { ok: true, status: 200, data: row };
}

export async function createProjectService(
  ctx: ProjectsActorCtx,
  input: CreateProjectInput,
  options?: { statusOverride?: string },
): Promise<ProjectsServiceResult<ProjectRow>> {
  if (!atLeast(ctx.actorRole, "manager") && !options?.statusOverride) {
    // Manager+ for the admin path. Portal-side calls pass statusOverride to
    // bypass this gate; portal route already enforces agent auth.
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const conflict = await findProjectByNameConflict({
    organizationId: ctx.orgId,
    name: input.name,
  });
  if (conflict) return { ok: false, status: 409, error: "Project name already exists" };

  const row = await withTransaction(async (tx) => {
    const created = await createProjectRow(tx, {
      ...input,
      organizationId: ctx.orgId,
      createdById: ctx.actorUserId,
      statusOverride: options?.statusOverride,
    });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options?.statusOverride === "unverified"
        ? "project.create.portal"
        : "project.create",
      entityType: "Project",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return created;
  });

  return { ok: true, status: 201, data: row };
}

export async function updateProjectService(
  ctx: ProjectsActorCtx,
  id: string,
  input: UpdateProjectInput,
): Promise<ProjectsServiceResult<ProjectRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const preCheck = await findProjectById(ctx.orgId, id);
  if (!preCheck) return { ok: false, status: 404, error: "Project not found" };

  if (input.name && input.name !== preCheck.name) {
    const conflict = await findProjectByNameConflict({
      organizationId: ctx.orgId,
      name: input.name,
      excludeId: id,
    });
    if (conflict) return { ok: false, status: 409, error: "Project name already exists" };
  }

  const result = await withTransaction(async (tx) => {
    const before = await findProjectByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    const updated = await updateProjectRow(tx, id, ctx.orgId, input);

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "project.update",
      entityType: "Project",
      entityId: id,
      diff: { before, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });

  if (!result) return { ok: false, status: 404, error: "Project not found" };
  return { ok: true, status: 200, data: result };
}
