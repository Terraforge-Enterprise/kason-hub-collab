import {
  optionalPhoneSchema,
  formatMyPhoneDisplay,
  readPhoneAnyFormat,
} from "@kason/shared";
import { portalPartiesRepository } from "./portal.parties.repository";

type Ctx = { orgId: string; agentPartyId: string; actorUserId: string };

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404; error: { code: string; message: string } };

export type OwnerRow = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  /** Pre-formatted display value (e.g. "+60 12-345 6789") so the portal
   *  picker can render the friendly form without bundling libphonenumber-js. */
  formattedPhone: string | null;
  primaryEmail: string | null;
};

/**
 * Add the API-DTO `formattedPhone` field next to `primaryPhone`. Read-tolerant
 * via `readPhoneAnyFormat` so legacy `+60` rows on un-backfilled UAT data
 * normalize to canonical at the boundary.
 */
function withFormattedPhone<T extends { primaryPhone: string | null }>(
  row: T,
): T & { formattedPhone: string | null } {
  const canonical = readPhoneAnyFormat(row.primaryPhone);
  return {
    ...row,
    primaryPhone: canonical,
    formattedPhone: canonical ? formatMyPhoneDisplay(canonical) : null,
  };
}

export async function searchOwnersService(
  input: { q: string },
  ctx: Ctx,
): Promise<Result<OwnerRow[]>> {
  const q = input.q.trim();
  if (q.length === 0) {
    return { ok: true, data: [] };
  }
  const rows = await portalPartiesRepository().searchOwnersForAgent(
    ctx.orgId,
    ctx.agentPartyId,
    q,
  );
  return { ok: true, data: rows.map(withFormattedPhone) };
}

export async function createOwnerService(
  input: { displayName: string; primaryPhone?: string | null; primaryEmail?: string },
  ctx: Ctx,
): Promise<Result<OwnerRow>> {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "invalid_display_name", message: "Owner name is required." },
    };
  }
  // Defensive re-validation: idempotent for canonical input, null stays null,
  // throws if a future caller bypasses route Zod and passes invalid phone.
  const phone = optionalPhoneSchema.parse(input.primaryPhone ?? null);
  const email = input.primaryEmail?.trim();
  const created = await portalPartiesRepository().createOwner({
    orgId: ctx.orgId,
    displayName,
    primaryPhone: phone ?? undefined,
    primaryEmail: email && email.length > 0 ? email : undefined,
    partyType: "owner",
  });
  return { ok: true, data: withFormattedPhone(created) };
}
