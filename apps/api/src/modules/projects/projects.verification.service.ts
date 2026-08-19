import { getDb } from "@kason/db";

type Ctx = { orgId: string; actorUserId: string };
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

export async function verifyProjectService(
  projectId: string,
  ctx: Ctx,
): Promise<Result<{ id: string; status: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: { id: projectId, organizationId: ctx.orgId },
      select: { id: true, status: true },
    });
    if (!project) {
      return { ok: false as const, status: 404 as const, error: { code: "project_not_found", message: "Project not found." } };
    }
    if (project.status !== "unverified") {
      return {
        ok: false as const,
        status: 409 as const,
        error: { code: "project_not_unverified", message: `Project is in status "${project.status}".` },
      };
    }
    await tx.project.updateMany({
      where: { id: projectId, organizationId: ctx.orgId, status: "unverified" },
      data: { status: "active", verifiedAt: new Date(), verifiedById: ctx.actorUserId },
    });
    await tx.projectVerificationTransition.create({
      data: {
        organizationId: ctx.orgId,
        projectId,
        fromStatus: "unverified",
        toStatus: "active",
        changedById: ctx.actorUserId,
      },
    });
    return { ok: true as const, data: { id: projectId, status: "active" } };
  });
}

export async function rejectProjectService(
  projectId: string,
  note: string,
  ctx: Ctx,
): Promise<Result<{ id: string; status: string }>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: { id: projectId, organizationId: ctx.orgId },
      select: { id: true, status: true },
    });
    if (!project) {
      return { ok: false as const, status: 404 as const, error: { code: "project_not_found", message: "Project not found." } };
    }
    if (project.status !== "unverified") {
      return {
        ok: false as const,
        status: 409 as const,
        error: { code: "project_not_unverified", message: `Project is in status "${project.status}".` },
      };
    }
    await tx.project.updateMany({
      where: { id: projectId, organizationId: ctx.orgId, status: "unverified" },
      data: { status: "archived" },
    });
    await tx.projectVerificationTransition.create({
      data: {
        organizationId: ctx.orgId,
        projectId,
        fromStatus: "unverified",
        toStatus: "archived",
        changedById: ctx.actorUserId,
        note,
      },
    });
    return { ok: true as const, data: { id: projectId, status: "archived" } };
  });
}

export async function listPendingVerificationService(orgId: string) {
  const db = getDb();
  const data = await db.project.findMany({
    where: { organizationId: orgId, status: "unverified" },
    orderBy: { createdAt: "desc" },
  });
  return { ok: true as const, data };
}
