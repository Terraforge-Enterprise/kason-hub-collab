import type { UpsertDefaultsInput } from "./sales-claim-defaults.validation";
import { salesClaimDefaultsRepository } from "./sales-claim-defaults.repository";

type Ctx = { orgId: string; actorUserId: string };
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404; error: { code: string; message: string } };

export async function getDefaultsService(opts: { orgId: string; appliesTo: string }) {
  const data = await salesClaimDefaultsRepository().findByOrgAndAppliesTo(opts.orgId, opts.appliesTo);
  if (!data) {
    return {
      ok: false as const,
      status: 404 as const,
      error: { code: "defaults_not_found", message: `No SalesClaimDefault for appliesTo="${opts.appliesTo}".` },
    };
  }
  return { ok: true as const, data };
}

export async function upsertDefaultsService(
  input: UpsertDefaultsInput,
  ctx: Ctx,
): Promise<Result<{ id: string }>> {
  const repo = salesClaimDefaultsRepository();
  const upserted = await repo.upsert(ctx.orgId, ctx.actorUserId, {
    appliesTo: input.appliesTo,
    commissionType: input.commissionType,
    commissionValue: input.commissionValue,
    paymentType: input.paymentType,
    notes: input.notes ?? null,
    splits: input.splits,
  });
  return { ok: true, data: { id: upserted.id } };
}
