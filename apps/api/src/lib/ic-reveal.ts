// Shared IC helpers — used by BOTH the parties module (always-on, Inventory
// tenant picker) and the tenant-tracker module (flag-gated). The unmasked IC
// leaves the server ONLY via recordIcRevealService, which writes one audit row
// in the SAME $transaction that serves the value (O3/PDPA).
import { getDb } from "@kason/db";
import type { IcRevealResponse } from "@kason/shared";
import { recordAudit } from "./audit";
import type { SessionPayload } from "./auth";

export type Result<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

const MASK = "••••";

/**
 * Mask an IC/passport number for list payloads: "••••" + last 4 chars.
 * null → null; values of length ≤ 4 are fully masked ("••••") so a short ID
 * never round-trips in full.
 */
export function maskIdNumber(idNumber: string | null): string | null {
  if (idNumber === null) return null;
  if (idNumber.length <= 4) return MASK;
  return MASK + idNumber.slice(-4);
}

/**
 * Audited unmasked-IC reveal — the ONLY unmasked-IC path. One audit row per
 * reveal, written in the SAME $transaction that serves the value, so a reveal
 * can never be served without its audit row. Role enforcement (mgr+) happens
 * at the route; the service records the actual actorRole from the session.
 *
 * A party with NO stored idNumber returns 404 "NO_IC" BEFORE recordAudit, so
 * no ic_reveal event is logged for a reveal that surfaced nothing.
 */
export async function recordIcRevealService(
  session: SessionPayload,
  partyId: string,
): Promise<Result<IcRevealResponse>> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, organizationId: session.orgId },
      select: { id: true, idNumber: true },
    });
    if (!party) return err(404, "PARTY_NOT_FOUND");
    if (party.idNumber === null || party.idNumber === "") return err(404, "NO_IC");

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "leasing.tenant.ic_reveal",
      entityType: "Party",
      entityId: partyId,
    });

    return ok({ partyId: party.id, idNumber: party.idNumber });
  });
}
