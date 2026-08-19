import {
  STAGE_CAP,
  deriveStageKey,
  type createStageSchema,
  type updateStageSchema,
  type reorderStagesSchema,
} from "./renovation-stages.validation";
import type { z } from "zod";
import { renovationStagesRepository } from "./renovation-stages.repository";

type Ctx = { orgId: string; actorUserId: string };
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

export async function listStagesService(opts: { orgId: string; includeArchived: boolean }) {
  const data = await renovationStagesRepository().list(opts.orgId, opts.includeArchived);
  return { ok: true as const, data };
}

export async function createStageService(
  input: z.infer<typeof createStageSchema>,
  ctx: Ctx,
): Promise<Result<{ id: string }>> {
  const repo = renovationStagesRepository();
  const count = await repo.count(ctx.orgId);
  if (count >= STAGE_CAP) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "stage_cap_exceeded",
        message: `Maximum ${STAGE_CAP} active stages per organization reached.`,
      },
    };
  }

  const key = deriveStageKey(input.label);
  const existing = await repo.findByKey(ctx.orgId, key);
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "duplicate_key",
        message: `Stage "${existing.label}" already uses key "${key}".`,
      },
    };
  }

  const created = await repo.create({
    orgId: ctx.orgId,
    key,
    label: input.label,
    description: input.description,
    sortOrder: input.sortOrder ?? count,
  });
  return { ok: true, data: { id: created.id } };
}

export async function updateStageService(
  id: string,
  input: z.infer<typeof updateStageSchema>,
  ctx: Ctx,
): Promise<Result<{ id: string }>> {
  const repo = renovationStagesRepository();
  const existing = await repo.findById(ctx.orgId, id);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      error: { code: "stage_not_found", message: "Stage not found." },
    };
  }
  await repo.update(ctx.orgId, id, input);
  return { ok: true, data: { id } };
}

export async function reorderStagesService(
  input: z.infer<typeof reorderStagesSchema>,
  ctx: Ctx,
): Promise<Result<{ count: number }>> {
  const repo = renovationStagesRepository();
  const result = await repo.reorder(ctx.orgId, input.items);
  return { ok: true, data: { count: result.count } };
}
