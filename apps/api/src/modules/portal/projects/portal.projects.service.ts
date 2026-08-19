import type { Prisma } from "@kason/db";

export type ResolveOrCreateProjectInput =
  | { mode: "existing"; id: string }
  | {
      mode: "new";
      name: string;
      developer: string;
      city?: string;
      expectedHandover?: string;
      notes?: string;
    };

export type ResolveOrCreateProjectCtx = {
  orgId: string;
  actorUserId: string;
};

export type ResolveOrCreateProjectResult =
  | { ok: true; data: { id: string; status: string; createdNew: boolean } }
  | { ok: false; status: 400 | 404; error: { code: string; message: string } };

/**
 * Resolves an existing project by id (org-scoped) or creates a new one
 * with status="unverified". Always called inside a parent Prisma
 * $transaction. Appends a ProjectVerificationTransition row when a new
 * project is created.
 */
export async function resolveOrCreateProjectService(
  tx: Prisma.TransactionClient,
  input: ResolveOrCreateProjectInput,
  ctx: ResolveOrCreateProjectCtx,
): Promise<ResolveOrCreateProjectResult> {
  if (input.mode === "existing") {
    const existing = await tx.project.findFirst({
      where: { id: input.id, organizationId: ctx.orgId },
      select: { id: true, status: true },
    });
    if (!existing) {
      return {
        ok: false,
        status: 404,
        error: { code: "project_not_found", message: "Project not found in this organization." },
      };
    }
    if (existing.status === "archived") {
      return {
        ok: false,
        status: 400,
        error: { code: "project_archived", message: "Project is archived and cannot accept new entries." },
      };
    }
    return { ok: true, data: { id: existing.id, status: existing.status, createdNew: false } };
  }

  const created = await tx.project.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name.trim(),
      developer: input.developer.trim(),
      city: input.city ?? null,
      expectedHandover: input.expectedHandover ? new Date(input.expectedHandover) : null,
      notes: input.notes ?? null,
      status: "unverified",
      createdById: ctx.actorUserId,
    },
    select: { id: true, status: true },
  });

  await tx.projectVerificationTransition.create({
    data: {
      organizationId: ctx.orgId,
      projectId: created.id,
      fromStatus: null,
      toStatus: "unverified",
      changedById: ctx.actorUserId,
    },
  });

  return { ok: true, data: { id: created.id, status: created.status, createdNew: true } };
}
