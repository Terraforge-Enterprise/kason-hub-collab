import type { z } from "zod";
import { getDb, Prisma } from "@kason/db";
import {
  optionalPhoneSchema,
  formatMyPhoneDisplay,
  readPhoneAnyFormat,
} from "@kason/shared";
import { hashPassword } from "../../lib/auth";
import { maskIdNumber } from "../../lib/ic-reveal";
import { createSignedDownloadUrl } from "../../lib/storage";
import { StaleUpdateError, NotFoundError, InvalidStateError } from "../../lib/concurrency-error";
import { authStatusCache } from "../../lib/auth-status-cache";
import { canSeeCommission, type AdminRole } from "../../lib/rbac";
import {
  blacklistOwnerSchema,
  blacklistTenantSchema,
  reactivateOwnerSchema,
  reactivateTenantSchema,
  createOwnerSchema,
  createTenantSchema,
  updateOwnerSchema,
  updateTenantSchema,
  createAgentSchema,
  updateAgentSchema,
  blacklistAgentSchema,
  reactivateAgentSchema,
  deactivateAgentSchema,
  activateAgentSchema,
  revokePortalAccessSchema,
} from "./parties.validation";
import type { PartiesSession, HierarchyNode } from "./parties.types";
import {
  createOwner,
  createTenant,
  createTenantTx,
  findPartyByIdNumber,
  findRole,
  findOwnerDetail,
  findUnitsOwned,
  findTenantDetail,
  findPortalUserByParty,
  hasActiveTenancy,
  listOwners,
  listTenants,
  searchTenants,
  searchOwners,
  updateParty,
  updatePartyTx,
  listAgents,
  listAssignableMembers,
  createAgent,
  createAgentTx,
  blacklistAgentTx,
  reactivateAgentTx,
  deactivateAgentTx,
  activateAgentTx,
  getAgentDetail,
  revokePortalAccessTx,
  getAgentHierarchy,
  getAncestors,
  getDirectDownlines,
  getSubtree,
  setUplineTx,
  validateUplineChange,
  checkContactUniqueness,
  describeContactViolation,
  isPartyDeletable,
  loadPartyDeletionShape,
  describeBlockers,
  deletePartyTx,
  type ListAgentsFilter,
  type PartyDeletionShape,
} from "./parties.repository";
import {
  createApprovedFromAdminTx,
  OrgCardSettingsNotConfiguredError,
} from "../agent-cards";
import { findValidUpline, rankOf } from "./upline-resolution";

/**
 * Columns where an empty-string from the client should be persisted as
 * NULL. These are nullable text columns where `""` carries no business
 * meaning — clearing the field means the user wants the value gone, not
 * that the value is the empty string. Applied to PATCH paths (agent /
 * owner / tenant updates) so the wire format `""` and `null` are
 * indistinguishable downstream of the service.
 *
 * IMPORTANT: this list MUST stay in sync with the corresponding Prisma
 * `String?` columns on Party. Adding a new nullable text column without
 * adding it here means clients can leave it as `""` instead of NULL.
 */
const NULLABLE_STRING_COLUMNS = [
  "legalName",
  "primaryEmail",
  "primaryPhone",
  "idType",
  "idNumber",
  "nationality",
  "bankName",
  "bankAccountHolder",
  "bankAccountNumber",
] as const;

/**
 * Maps `""` → `null` for any field listed in `NULLABLE_STRING_COLUMNS`.
 * Leaves other types and keys untouched. Pure function — safe to call on
 * any object whose extra fields the caller wants to preserve.
 *
 * Why server-side: the agent edit drawer forwards `""` explicitly so the
 * user's "clear this field" intent is unambiguous on the wire (vs.
 * `undefined`, which means "don't change"). The DB column wants `null`,
 * not `""`. Doing this in the service layer means every entry point —
 * routes, scripts, future migrations — gets the same behaviour without
 * burdening every caller with the rule.
 */
export function coerceEmptyStringsToNull<T extends Record<string, unknown>>(
  input: T,
): T {
  const out: Record<string, unknown> = { ...input };
  for (const col of NULLABLE_STRING_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(out, col) && out[col] === "") {
      out[col] = null;
    }
  }
  return out as T;
}

/**
 * Builds the `fieldErrors` map returned on a duplicate (409) conflict so the
 * client can turn the offending input red. The create/edit dialogs bind each
 * input's inline error to `fieldErrors[<inputName>]`, and before this only the
 * Zod-400 path populated that map — so duplicates showed a toast but reddened
 * no field. Keys MUST match the form input `name`s exactly: primaryEmail /
 * primaryPhone / idNumber.
 */
function contactConflictFieldErrors(
  field: "email" | "phone",
  displayName: string,
): Record<string, string> {
  const key = field === "email" ? "primaryEmail" : "primaryPhone";
  return { [key]: `Already used by ${displayName}` };
}

/**
 * Project a Party-shaped row's `primaryPhone` (which may legitimately be
 * canonical `60XXXXXXXXX` post-backfill, or legacy `+60XXXXXXXXX` on
 * un-backfilled UAT data) into the API DTO contract:
 *
 *   - `primaryPhone`: canonical (`60XXXXXXXXX`) — read-tolerant via
 *     `readPhoneAnyFormat`, so legacy `+60` rows surface canonical.
 *   - `formattedPhone`: friendly display (`+60 12-345 6789`) — pre-rendered
 *     server-side so the client doesn't pull libphonenumber-js into its
 *     bundle.
 *
 * Both are `null` when the source phone is missing or unparseable. Pure
 * function — safe to call inside `.map()` over Prisma rows.
 */
function withFormattedPhone<T extends { primaryPhone: string | null }>(
  row: T,
): Omit<T, "primaryPhone"> & { primaryPhone: string | null; formattedPhone: string | null } {
  const canonical = readPhoneAnyFormat(row.primaryPhone);
  return {
    ...row,
    primaryPhone: canonical,
    formattedPhone: canonical ? formatMyPhoneDisplay(canonical) : null,
  };
}

/**
 * Collapse a party's property/unit pairs to DISTINCT entries keyed by the
 * composite (propertyName, unitCode), sorted by property then unit. Skips any
 * partial entry (defensive; FKs are non-null so this should not occur). Shared
 * by getTenantsService (active tenancies) and getOwnersService (owned units).
 */
function dedupeUnits(
  units: { propertyName: string | null | undefined; unitCode: string | null | undefined }[],
): { propertyName: string; unitCode: string }[] {
  const seen = new Map<string, { propertyName: string; unitCode: string }>();
  for (const u of units) {
    if (!u || !u.propertyName || !u.unitCode) continue;
    const key = `${u.propertyName}\u0000${u.unitCode}`; // delimiter is a NUL char (U+0000), written as the printable \u0000 escape in source (never a literal 0x00 byte in this file); property/unit codes never contain NUL, so keys can't collide
    if (!seen.has(key)) seen.set(key, { propertyName: u.propertyName, unitCode: u.unitCode });
  }
  return [...seen.values()].sort(
    (a, b) => a.propertyName.localeCompare(b.propertyName) || a.unitCode.localeCompare(b.unitCode),
  );
}

export async function getOwnersService(session: PartiesSession) {
  const rows = await listOwners(session.orgId);
  return rows.map((r) => {
    const { idNumber, _count, userAccount, ownedUnits, ...rest } = r as typeof r & {
      _count: unknown; userAccount: unknown;
      ownedUnits?: { apartment: { unitCode: string; property: { name: string } } }[];
    };
    const units = dedupeUnits(
      (ownedUnits ?? []).map((l) => ({
        propertyName: l.apartment?.property?.name,
        unitCode: l.apartment?.unitCode,
      })),
    );
    return withFormattedPhone({
      ...rest,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      idNumberMasked: maskIdNumber(idNumber),
      deletable: isPartyDeletable(r as unknown as PartyDeletionShape),
      units,
    });
  });
}

export async function getTenantsService(session: PartiesSession) {
  const rows = await listTenants(session.orgId);
  return rows.map((r) => {
    const { idNumber, _count, userAccount, tenancies, ...rest } = r as typeof r & {
      _count: unknown; userAccount: unknown;
      tenancies?: { property: { name: string }; unit: { apartment: { unitCode: string } } }[];
    };
    const units = dedupeUnits(
      (tenancies ?? []).map((t) => ({
        propertyName: t.property?.name,
        unitCode: t.unit?.apartment?.unitCode,
      })),
    );
    return withFormattedPhone({
      ...rest,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      monthlyIncome: r.monthlyIncome?.toString() ?? null,
      idNumberMasked: maskIdNumber(idNumber),
      deletable: isPartyDeletable(r as unknown as PartyDeletionShape),
      hasReservation: (_count as { reservationsCreatedFrom: number }).reservationsCreatedFrom > 0,
      units,
    });
  });
}

export async function getTenantDetailService(
  session: PartiesSession,
  partyId: string,
) {
  const row = await findTenantDetail(session.orgId, partyId);
  if (!row) return { ok: false as const, status: 404 as const, error: "Tenant not found" };
  const [portalUser, activeTenancy] = await Promise.all([
    findPortalUserByParty(session.orgId, partyId),
    hasActiveTenancy(session.orgId, partyId),
  ]);
  const withPhone = withFormattedPhone(row);
  const { idNumber: _idNumber, ...rest } = withPhone;
  return {
    ok: true as const,
    status: 200 as const,
    data: {
      ...rest,
      idNumberMasked: maskIdNumber(row.idNumber),
      monthlyIncome: row.monthlyIncome?.toString() ?? null,
      dateOfBirth: row.dateOfBirth?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      hasActiveTenancy: activeTenancy,
      portalUser: portalUser
        ? {
            email: portalUser.email,
            status: portalUser.status,
            lastLoginAt: portalUser.lastLoginAt?.toISOString() ?? null,
            updatedAt: portalUser.updatedAt.toISOString(),
          }
        : null,
    },
  };
}

export async function getOwnerDetailService(
  session: PartiesSession,
  partyId: string,
) {
  const row = await findOwnerDetail(session.orgId, partyId);
  if (!row) return { ok: false as const, status: 404 as const, error: "Owner not found" };
  const [unitsOwned, portalUser] = await Promise.all([
    findUnitsOwned(session.orgId, partyId),
    findPortalUserByParty(session.orgId, partyId),
  ]);
  const withPhone = withFormattedPhone(row);
  const { idNumber: _idNumber, bankName, bankAccountHolder, bankAccountNumber, ...rest } = withPhone;
  return {
    ok: true as const,
    status: 200 as const,
    data: {
      ...rest,
      idNumberMasked: maskIdNumber(row.idNumber),
      bank: {
        name: bankName,
        accountHolder: bankAccountHolder,
        accountNumber: bankAccountNumber,
      },
      dateOfBirth: row.dateOfBirth?.toISOString() ?? null,
      // Prisma Decimal → plain string, same idiom as getTenantDetailService.
      // Without this, `...rest` would pass through the raw Decimal instance
      // now that findOwnerDetail's select includes monthlyIncome.
      monthlyIncome: row.monthlyIncome?.toString() ?? null,
      unitsOwned,
      createdAt: row.createdAt.toISOString(),
      portalUser: portalUser
        ? {
            email: portalUser.email,
            status: portalUser.status,
            lastLoginAt: portalUser.lastLoginAt?.toISOString() ?? null,
            updatedAt: portalUser.updatedAt.toISOString(),
          }
        : null,
    },
  };
}

export async function createOwnerService(session: PartiesSession, input: z.infer<typeof createOwnerSchema>) {
  if (input.idNumber) {
    const dup = await findPartyByIdNumber(session.orgId, input.idNumber);
    // Neutral wording: findPartyByIdNumber is org-wide, not owner-scoped, so
    // the match could be an existing tenant or agent, not just another owner.
    if (dup) return { ok: false as const, status: 409, error: "This ID/passport number is already registered.", fieldErrors: { idNumber: "Already registered to another party" } };
  }
  const conflict = await checkContactUniqueness(session.orgId, { email: input.primaryEmail, phone: input.primaryPhone });
  if (conflict) {
    const what = conflict.field === "email" ? "email" : "phone number";
    return {
      ok: false as const,
      status: 409,
      error: `This ${what} is already used by ${conflict.party.displayName}.`,
      fieldErrors: contactConflictFieldErrors(conflict.field, conflict.party.displayName),
    };
  }
  let owner;
  try {
    owner = await createOwner(session.orgId, input as Record<string, unknown>);
  } catch (err) {
    const dup = describeContactViolation(err, "owner");
    if (dup) return { ok: false as const, ...dup };
    throw err;
  }
  return { ok: true as const, status: 201, data: owner };
}

export async function updateOwnerService(session: PartiesSession, input: z.infer<typeof updateOwnerSchema>) {
  const role = await findRole(session.orgId, input.partyId, "owner");
  if (!role) return { ok: false as const, status: 404, error: "Owner not found" };
  const { partyId, ...rest } = input;
  if (rest.idNumber) {
    const dup = await findPartyByIdNumber(session.orgId, rest.idNumber);
    if (dup && dup.id !== partyId) {
      return { ok: false as const, status: 409, error: "Owner ID/passport already exists", fieldErrors: { idNumber: "Already registered to another party" } };
    }
  }
  const conflict = await checkContactUniqueness(session.orgId, { email: rest.primaryEmail, phone: rest.primaryPhone, excludePartyId: partyId });
  if (conflict) {
    const what = conflict.field === "email" ? "email" : "phone number";
    return {
      ok: false as const,
      status: 409,
      error: `This ${what} is already used by ${conflict.party.displayName}.`,
      fieldErrors: contactConflictFieldErrors(conflict.field, conflict.party.displayName),
    };
  }
  try {
    await updateParty(partyId, {
      ...(rest.displayName !== undefined ? { displayName: rest.displayName } : {}),
      ...(rest.legalName !== undefined ? { legalName: rest.legalName || null } : {}),
      ...(rest.primaryEmail !== undefined ? { primaryEmail: rest.primaryEmail || null } : {}),
      ...(rest.primaryPhone !== undefined
        ? { primaryPhone: optionalPhoneSchema.parse(rest.primaryPhone || null) }
        : {}),
      ...(rest.idType !== undefined ? { idType: rest.idType || null } : {}),
      ...(rest.idNumber !== undefined ? { idNumber: rest.idNumber || null } : {}),
      ...(rest.nationality !== undefined ? { nationality: rest.nationality || null } : {}),
      ...(rest.bankName !== undefined ? { bankName: rest.bankName || null } : {}),
      ...(rest.bankAccountHolder !== undefined ? { bankAccountHolder: rest.bankAccountHolder || null } : {}),
      ...(rest.bankAccountNumber !== undefined ? { bankAccountNumber: rest.bankAccountNumber || null } : {}),
      ...(rest.whatsappPhone !== undefined ? { whatsappPhone: rest.whatsappPhone || null } : {}),
      ...(rest.gender !== undefined ? { gender: rest.gender || null } : {}),
      ...(rest.dateOfBirth !== undefined
        ? { dateOfBirth: rest.dateOfBirth ? new Date(rest.dateOfBirth) : null }
        : {}),
      ...(rest.occupation !== undefined ? { occupation: rest.occupation || null } : {}),
      ...(rest.employerName !== undefined ? { employerName: rest.employerName || null } : {}),
      ...(rest.employerAddress !== undefined ? { employerAddress: rest.employerAddress || null } : {}),
      ...(rest.monthlyIncome !== undefined ? { monthlyIncome: rest.monthlyIncome === "" ? null : Number(rest.monthlyIncome) } : {}),
      ...(rest.emergencyContactName !== undefined ? { emergencyContactName: rest.emergencyContactName || null } : {}),
      ...(rest.emergencyContactPhone !== undefined ? { emergencyContactPhone: rest.emergencyContactPhone || null } : {}),
      ...(rest.emergencyContactRelation !== undefined ? { emergencyContactRelation: rest.emergencyContactRelation || null } : {}),
    });
  } catch (err) {
    const dup = describeContactViolation(err, "owner");
    if (dup) return { ok: false as const, ...dup };
    throw err;
  }
  return { ok: true as const, status: 200, data: { id: partyId } };
}

export async function blacklistOwnerService(session: PartiesSession, input: z.infer<typeof blacklistOwnerSchema>) {
  const role = await findRole(session.orgId, input.partyId, "owner");
  if (!role) return { ok: false as const, status: 404, error: "Owner not found" };
  await updateParty(input.partyId, { isBlacklisted: true, blacklistReason: input.reason, status: "inactive" });
  return { ok: true as const, status: 200, data: { id: input.partyId } };
}

export async function createTenantService(session: PartiesSession, input: z.infer<typeof createTenantSchema>) {
  if (input.idNumber) {
    const dup = await findPartyByIdNumber(session.orgId, input.idNumber);
    if (dup) return { ok: false as const, status: 409, error: "Tenant ID/passport already exists", fieldErrors: { idNumber: "Already registered to another party" } };
  }
  const conflict = await checkContactUniqueness(session.orgId, { email: input.primaryEmail, phone: input.primaryPhone });
  if (conflict) {
    const what = conflict.field === "email" ? "email" : "phone number";
    return {
      ok: false as const,
      status: 409,
      error: `This ${what} is already used by ${conflict.party.displayName}.`,
      fieldErrors: contactConflictFieldErrors(conflict.field, conflict.party.displayName),
    };
  }

  // "From reservation" path: the tenant create AND the reservation link must
  // commit (or roll back) together. A conditional UPDATE (WHERE status =
  // 'signed' AND tenantPartyId IS NULL) inside the SAME transaction is what
  // makes two concurrent creates from the same reservation race-safe — the
  // loser's updateMany matches 0 rows, we throw, and the whole transaction
  // (including the just-created Party) rolls back. No orphan Party, no
  // double-linked reservation.
  if (input.reservationId) {
    const reservationId = input.reservationId;
    const db = getDb();
    try {
      const tenant = await db.$transaction(async (tx) => {
        const resv = await tx.unitReservation.findFirst({
          where: { id: reservationId, organizationId: session.orgId },
          select: {
            nationality: true, occupation: true, monthlyIncome: true,
            emergencyContactName: true, emergencyContactPhone: true, emergencyContactRelation: true,
          },
        });
        const merged: Record<string, unknown> = {
          ...(input as Record<string, unknown>),
          nationality: (input as Record<string, unknown>).nationality ?? resv?.nationality ?? undefined,
          occupation: (input as Record<string, unknown>).occupation ?? resv?.occupation ?? undefined,
          monthlyIncome: (input as Record<string, unknown>).monthlyIncome ?? (resv?.monthlyIncome != null ? resv.monthlyIncome.toString() : undefined),
          emergencyContactName: (input as Record<string, unknown>).emergencyContactName ?? resv?.emergencyContactName ?? undefined,
          emergencyContactPhone: (input as Record<string, unknown>).emergencyContactPhone ?? resv?.emergencyContactPhone ?? undefined,
          emergencyContactRelation: (input as Record<string, unknown>).emergencyContactRelation ?? resv?.emergencyContactRelation ?? undefined,
        };
        const t = await createTenantTx(tx, session.orgId, merged);
        const linked = await tx.unitReservation.updateMany({
          where: { id: reservationId, organizationId: session.orgId, status: "signed", tenantPartyId: null },
          data: { tenantPartyId: t.id },
        });
        if (linked.count === 0) {
          throw Object.assign(new Error("RESERVATION_NOT_PICKABLE"), { _notPickable: true });
        }
        return t;
      });
      return { ok: true as const, status: 201, data: tenant };
    } catch (err) {
      if ((err as { _notPickable?: boolean })._notPickable) {
        return { ok: false as const, status: 409, error: "Reservation is not available (unsigned or already used)." };
      }
      const dup = describeContactViolation(err, "tenant");
      if (dup) return { ok: false as const, ...dup };
      throw err;
    }
  }

  let tenant;
  try {
    tenant = await createTenant(session.orgId, input as Record<string, unknown>);
  } catch (err) {
    const dup = describeContactViolation(err, "tenant");
    if (dup) return { ok: false as const, ...dup };
    throw err;
  }
  return { ok: true as const, status: 201, data: tenant };
}

export async function updateTenantService(session: PartiesSession, input: z.infer<typeof updateTenantSchema>) {
  const role = await findRole(session.orgId, input.partyId, "tenant");
  if (!role) return { ok: false as const, status: 404, error: "Tenant not found" };
  const { partyId, ...rest } = input;
  if (rest.idNumber) {
    const dup = await findPartyByIdNumber(session.orgId, rest.idNumber);
    if (dup && dup.id !== partyId) {
      return { ok: false as const, status: 409, error: "Tenant ID/passport already exists", fieldErrors: { idNumber: "Already registered to another party" } };
    }
  }
  const conflict = await checkContactUniqueness(session.orgId, { email: rest.primaryEmail, phone: rest.primaryPhone, excludePartyId: partyId });
  if (conflict) {
    const what = conflict.field === "email" ? "email" : "phone number";
    return {
      ok: false as const,
      status: 409,
      error: `This ${what} is already used by ${conflict.party.displayName}.`,
      fieldErrors: contactConflictFieldErrors(conflict.field, conflict.party.displayName),
    };
  }
  try {
    await updateParty(partyId, {
      ...(rest.displayName !== undefined ? { displayName: rest.displayName } : {}),
      ...(rest.legalName !== undefined ? { legalName: rest.legalName || null } : {}),
      ...(rest.primaryEmail !== undefined ? { primaryEmail: rest.primaryEmail || null } : {}),
      ...(rest.primaryPhone !== undefined
        ? { primaryPhone: optionalPhoneSchema.parse(rest.primaryPhone || null) }
        : {}),
      ...(rest.idType !== undefined ? { idType: rest.idType || null } : {}),
      ...(rest.idNumber !== undefined ? { idNumber: rest.idNumber || null } : {}),
      ...(rest.nationality !== undefined ? { nationality: rest.nationality || null } : {}),
      ...(rest.occupation !== undefined ? { occupation: rest.occupation || null } : {}),
      ...(rest.employerName !== undefined ? { employerName: rest.employerName || null } : {}),
      ...(rest.employerAddress !== undefined ? { employerAddress: rest.employerAddress || null } : {}),
      ...(rest.monthlyIncome !== undefined ? { monthlyIncome: rest.monthlyIncome === "" ? null : Number(rest.monthlyIncome) } : {}),
      ...(rest.whatsappPhone !== undefined ? { whatsappPhone: rest.whatsappPhone || null } : {}),
      ...(rest.gender !== undefined ? { gender: rest.gender || null } : {}),
      ...(rest.dateOfBirth !== undefined
        ? { dateOfBirth: rest.dateOfBirth ? new Date(rest.dateOfBirth) : null }
        : {}),
      ...(rest.emergencyContactName !== undefined ? { emergencyContactName: rest.emergencyContactName || null } : {}),
      ...(rest.emergencyContactPhone !== undefined ? { emergencyContactPhone: rest.emergencyContactPhone || null } : {}),
      ...(rest.emergencyContactRelation !== undefined ? { emergencyContactRelation: rest.emergencyContactRelation || null } : {}),
    });
  } catch (err) {
    const dup = describeContactViolation(err, "tenant");
    if (dup) return { ok: false as const, ...dup };
    throw err;
  }
  return { ok: true as const, status: 200, data: { id: partyId } };
}

export async function blacklistTenantService(session: PartiesSession, input: z.infer<typeof blacklistTenantSchema>) {
  const role = await findRole(session.orgId, input.partyId, "tenant");
  if (!role) return { ok: false as const, status: 404, error: "Tenant not found" };
  await updateParty(input.partyId, { isBlacklisted: true, blacklistReason: input.reason, status: "inactive" });
  return { ok: true as const, status: 200, data: { id: input.partyId } };
}

export async function reactivateTenantService(session: PartiesSession, input: z.infer<typeof reactivateTenantSchema>) {
  const role = await findRole(session.orgId, input.partyId, "tenant");
  if (!role) return { ok: false as const, status: 404, error: "Tenant not found" };
  await updateParty(input.partyId, { isBlacklisted: false, blacklistReason: null, status: input.status ?? "active" });
  return { ok: true as const, status: 200, data: { id: input.partyId } };
}

export async function reactivateOwnerService(session: PartiesSession, input: z.infer<typeof reactivateOwnerSchema>) {
  const role = await findRole(session.orgId, input.partyId, "owner");
  if (!role) return { ok: false as const, status: 404, error: "Owner not found" };
  await updateParty(input.partyId, { isBlacklisted: false, blacklistReason: null, status: input.status ?? "active" });
  return { ok: true as const, status: 200, data: { id: input.partyId } };
}

export async function setPartyStatusService(
  session: PartiesSession,
  role: "tenant" | "owner",
  input: { partyId: string; status: "active" | "inactive" },
) {
  const found = await findRole(session.orgId, input.partyId, role);
  if (!found) return { ok: false as const, status: 404, error: role === "tenant" ? "Tenant not found" : "Owner not found" };
  const db = getDb();
  const party = await db.party.findFirst({ where: { id: input.partyId, organizationId: session.orgId }, select: { isBlacklisted: true } });
  if (party?.isBlacklisted) return { ok: false as const, status: 409, error: "Resolve the blacklist before changing active status." };
  await updateParty(input.partyId, { status: input.status });
  return { ok: true as const, status: 200, data: { id: input.partyId } };
}

export async function getAgentsService(session: PartiesSession, filter: ListAgentsFilter = {}) {
  const agents = await listAgents(session.orgId, filter);
  // Slim shape (q present): {id, displayName, agentLevel, status} only —
  // no phone, no userAccount, no dates. Pass through as-is.
  if (filter.q) {
    return agents;
  }
  // Full shape — map Date → ISO string, rename userAccount → portalUser, inject photoUrl,
  // pre-format phone for the table display (avoids client-side libphonenumber-js).
  return Promise.all(
    (agents as Array<{
      id: string; displayName: string; legalName: string | null;
      primaryEmail: string | null; primaryPhone: string | null;
      nationality: string | null; isBlacklisted: boolean; status: string;
      agentLevel: string | null; createdAt: Date; updatedAt: Date;
      idType: string | null; idNumber: string | null;
      bankName: string | null; bankAccountHolder: string | null; bankAccountNumber: string | null;
      photoKey: string | null;
      userAccount: { id: string; email: string; status: string; updatedAt: Date } | null;
      uplineId: string | null;
      upline: { id: string; displayName: string } | null;
    }>).map(async (a) => withFormattedPhone({
      ...a,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      photoUrl: a.photoKey ? await createSignedDownloadUrl(a.photoKey) : null,
      portalUser: a.userAccount
        ? {
            id: a.userAccount.id,
            email: a.userAccount.email,
            status: a.userAccount.status,
            updatedAt: a.userAccount.updatedAt.toISOString(),
          }
        : null,
      userAccount: undefined,
    })),
  );
}

/**
 * Slim list of every assignable org member (agents, managers, admins, super-admins).
 *
 * Drives the Unit dialog's "In charge" + "Hidden from" typeaheads. Returns the
 * partyType so the UI can render a "(admin)"/"(manager)" hint next to the
 * agent level for non-agent rows.
 */
export async function listAssignableMembersService(
  session: PartiesSession,
  q: string | undefined,
  take?: number,
  partyTypes?: ReadonlyArray<string>,
) {
  const rows = await listAssignableMembers(session.orgId, q, take ?? 20, partyTypes);
  // Flatten userAccount.role onto the row so the typeahead doesn't have to
  // dot into a nested object. Operator parties get the User.role string
  // (admin/manager/editor/viewer); everyone else gets null.
  const flat = rows.map(({ userAccount, ...rest }) => ({
    ...rest,
    role: userAccount?.role ?? null,
  }));
  return { data: flat };
}

export async function createAgentService(
  session: PartiesSession,
  input: z.infer<typeof createAgentSchema>,
) {
  // The optional `title` field signals that the admin wants an E-Namecard
  // (AgentCardVersion) created in the same atomic write as the new Party.
  // When absent, the existing single-purpose path is preserved (no card
  // mutation, no settings precondition).
  const { title, ...rest } = input as z.infer<typeof createAgentSchema> & {
    title?: string;
  };
  const titleTrimmed = typeof title === "string" ? title.trim() : "";

  if (!titleTrimmed) {
    const agent = await createAgent(session.orgId, rest as Record<string, unknown>);
    return { ok: true as const, status: 201 as const, data: { id: agent.id } };
  }

  // Title supplied → run Party creation AND card minting on a single
  // transaction so they commit/rollback together. agent-cards exposes a
  // tx-aware variant exactly for this case.
  const db = getDb();
  try {
    const agentId = await db.$transaction(async (tx) => {
      const agent = await createAgentTx(tx, session.orgId, rest as Record<string, unknown>);
      await createApprovedFromAdminTx(tx, {
        organizationId: session.orgId,
        partyId: agent.id,
        displayName: agent.displayName,
        title: titleTrimmed,
        primaryEmail: agent.primaryEmail ?? null,
        primaryPhone: agent.primaryPhone ?? null,
        submittedById: session.userId,
        actorRole: session.role,
      });
      return agent.id;
    });
    return { ok: true as const, status: 201 as const, data: { id: agentId } };
  } catch (err) {
    if (err instanceof OrgCardSettingsNotConfiguredError) {
      return { ok: false as const, status: 409 as const, error: err.message };
    }
    throw err;
  }
}

export async function updateAgentService(
  session: PartiesSession,
  input: z.infer<typeof updateAgentSchema>,
) {
  const role = await findRole(session.orgId, input.partyId, "agent");
  if (!role) return { ok: false as const, status: 404, error: "Agent not found" };

  const { partyId, updatedAt, uplineId, ...fields } = input;

  if (uplineId !== undefined) {
    const check = await validateUplineChange(session.orgId, partyId, uplineId);
    if (!check.ok) return { ok: false as const, status: 400, error: check.error };
  }

  const writeData = coerceEmptyStringsToNull({
    ...fields,
    ...(uplineId !== undefined ? { uplineId } : {}),
  });

  // No level change → fast path: single non-tx write, no audit-log entry to
  // synchronize, no restructure to compute.
  if (input.agentLevel === undefined) {
    const result = await updateParty(partyId, updatedAt, writeData);
    if (!result) {
      const stillExists = await findRole(session.orgId, partyId, "agent");
      if (!stillExists) return { ok: false as const, status: 404, error: "Agent not found" };
      return { ok: false as const, status: 409, error: "Record changed — reloaded" };
    }
    return {
      ok: true as const,
      status: 200 as const,
      data: { id: partyId, updatedAt: result.updatedAt.toISOString() },
    };
  }
  // TypeScript drops the early-return narrowing once we read input.agentLevel
  // inside the async tx callback below. Bind it once so we don't have to
  // non-null-assert on every use.
  const newAgentLevel = input.agentLevel;

  // Level change → all writes (party.update + agent_level_changed audit +
  // upline restructures + their audit entries) commit together inside one
  // transaction. If any step throws, the level write rolls back too — the
  // tree never lands in an inverted state with no audit trail.
  const db = getDb();
  let txStaleConflict = false;
  let txWrittenUpdatedAt: Date | null = null;
  const restructured: Array<{
    agentId: string;
    agentName: string;
    oldUplineId: string | null;
    oldUplineName: string | null;
    oldUplineLevel: string | null;
    newUplineId: string | null;
    newUplineName: string | null;
    newUplineLevel: string | null;
  }> = [];

  await db.$transaction(async (tx) => {
    // 1. Profile/level write WITH optimistic-concurrency check. Bailing out
    //    of the tx (return without throwing) keeps the whole transaction
    //    atomic — the audit + restructure writes below never run.
    const writeResult = await updatePartyTx(tx, partyId, updatedAt, writeData);
    if (writeResult === null) {
      txStaleConflict = true;
      return;
    }
    txWrittenUpdatedAt = writeResult.updatedAt;

    // 2. Log the level change itself.
    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "party",
        entityId: partyId,
        action: "agent_level_changed",
        description: `Agent level changed to ${newAgentLevel}`,
        performedBy: session.userId,
        metadata: { agentLevel: newAgentLevel },
      },
    });

    const newRank = rankOf(newAgentLevel);

    // PROMOTION-side: walk past the current upline if it is now ranked
    // below self. Walk starts at the CURRENT upline's upline so we skip
    // past the inverted ancestor.
    const self = await tx.party.findFirst({
      where: { id: partyId, organizationId: session.orgId },
      select: { uplineId: true, displayName: true },
    });
    if (self?.uplineId) {
      const currentUpline = await tx.party.findFirst({
        where: { id: self.uplineId, organizationId: session.orgId },
        select: { id: true, uplineId: true, agentLevel: true, status: true, displayName: true },
      });
      if (
        currentUpline &&
        currentUpline.status === "active" &&
        rankOf(currentUpline.agentLevel) < newRank
      ) {
        const newUplineId = await findValidUpline(
          tx,
          session.orgId,
          currentUpline.uplineId,
          newRank,
        );
        if (newUplineId !== self.uplineId) {
          const newUplineRow = newUplineId
            ? await tx.party.findFirst({
                where: { id: newUplineId, organizationId: session.orgId },
                select: { displayName: true, agentLevel: true },
              })
            : null;
          await tx.party.update({
            where: { id: partyId },
            data: { uplineId: newUplineId },
          });
          await tx.activityLog.create({
            data: {
              organizationId: session.orgId,
              entityType: "party",
              entityId: partyId,
              action: "agent_upline_auto_reassigned",
              description: `Upline auto-changed from ${currentUpline.displayName} to ${newUplineRow?.displayName ?? "(none)"} due to level inversion`,
              performedBy: session.userId,
              metadata: { reason: "level_inversion", oldUplineId: self.uplineId, newUplineId },
            },
          });
          restructured.push({
            agentId: partyId,
            agentName: self.displayName,
            oldUplineId: self.uplineId,
            oldUplineName: currentUpline.displayName,
            oldUplineLevel: currentUpline.agentLevel,
            newUplineId,
            newUplineName: newUplineRow?.displayName ?? null,
            newUplineLevel: newUplineRow?.agentLevel ?? null,
          });
        }
      }
    }

    // DEMOTION-side: any direct downline whose rank > new self rank
    // bubbles up. Walk starts from self's (possibly just updated) upline.
    const inverted = await tx.party.findMany({
      where: {
        organizationId: session.orgId,
        uplineId: partyId,
        status: "active",
      },
      select: { id: true, agentLevel: true, displayName: true },
    });
    if (inverted.length > 0) {
      const refreshedSelf = await tx.party.findFirst({
        where: { id: partyId, organizationId: session.orgId },
        select: { uplineId: true },
      });
      for (const dl of inverted) {
        if (rankOf(dl.agentLevel) > newRank) {
          const newUplineId = await findValidUpline(
            tx,
            session.orgId,
            refreshedSelf?.uplineId ?? null,
            rankOf(dl.agentLevel),
          );
          if (newUplineId !== partyId) {
            const newUplineRow = newUplineId
              ? await tx.party.findFirst({
                  where: { id: newUplineId, organizationId: session.orgId },
                  select: { displayName: true, agentLevel: true },
                })
              : null;
            await tx.party.update({
              where: { id: dl.id },
              data: { uplineId: newUplineId },
            });
            await tx.activityLog.create({
              data: {
                organizationId: session.orgId,
                entityType: "party",
                entityId: dl.id,
                action: "agent_upline_auto_reassigned",
                description: `Upline auto-changed from ${self?.displayName ?? "(unknown)"} to ${newUplineRow?.displayName ?? "(none)"} due to level inversion`,
                performedBy: session.userId,
                metadata: { reason: "level_inversion", oldUplineId: partyId, newUplineId },
              },
            });
            restructured.push({
              agentId: dl.id,
              agentName: dl.displayName,
              oldUplineId: partyId,
              oldUplineName: self?.displayName ?? null,
              oldUplineLevel: newAgentLevel,
              newUplineId,
              newUplineName: newUplineRow?.displayName ?? null,
              newUplineLevel: newUplineRow?.agentLevel ?? null,
            });
          }
        }
      }
    }
  });

  if (txStaleConflict) {
    const stillExists = await findRole(session.orgId, partyId, "agent");
    if (!stillExists) return { ok: false as const, status: 404, error: "Agent not found" };
    return { ok: false as const, status: 409, error: "Record changed — reloaded" };
  }
  if (!txWrittenUpdatedAt) {
    // Defensive: $transaction returned without throwing and without setting
    // stale-conflict — should be unreachable given the early-return guard.
    return { ok: false as const, status: 500, error: "Update did not complete" };
  }
  return {
    ok: true as const,
    status: 200 as const,
    data: { id: partyId, updatedAt: (txWrittenUpdatedAt as Date).toISOString() },
    ...(restructured.length > 0 ? { restructured } : {}),
  };
}

export async function blacklistAgentService(
  session: PartiesSession,
  input: z.infer<typeof blacklistAgentSchema>,
) {
  const role = await findRole(session.orgId, input.partyId, "agent");
  if (!role) return { ok: false as const, status: 404, error: "Agent not found" };

  let result: { updatedAt: Date; detachedDownlineIds: string[] };
  try {
    result = await blacklistAgentTx(session.orgId, input.partyId, input.reason, input.updatedAt, session.userId);
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: "Record changed — reloaded" };
    }
    throw err;
  }
  return { ok: true as const, status: 200 as const, data: { id: input.partyId, updatedAt: result.updatedAt.toISOString() } };
}

export async function reactivateAgentService(
  session: PartiesSession,
  input: z.infer<typeof reactivateAgentSchema>,
) {
  const role = await findRole(session.orgId, input.partyId, "agent");
  if (!role) return { ok: false as const, status: 404, error: "Agent not found" };
  try {
    const result = await reactivateAgentTx(session.orgId, input.partyId, input.note, input.updatedAt, session.userId);
    return { ok: true as const, status: 200 as const, data: { id: input.partyId, updatedAt: result.updatedAt.toISOString() } };
  } catch (err) {
    if (err instanceof StaleUpdateError) return { ok: false as const, status: 409, error: "Record changed — reloaded" };
    if (err instanceof InvalidStateError && err.code === "NOT_BLACKLISTED") return { ok: false as const, status: 409, error: err.message };
    if (err instanceof NotFoundError) return { ok: false as const, status: 404, error: "Agent not found" };
    throw err;
  }
}

export async function deactivateAgentService(
  session: PartiesSession,
  input: z.infer<typeof deactivateAgentSchema>,
) {
  const role = await findRole(session.orgId, input.partyId, "agent");
  if (!role) return { ok: false as const, status: 404, error: "Agent not found" };
  try {
    const result = await deactivateAgentTx(session.orgId, input.partyId, input.note, input.updatedAt, session.userId);
    // Portal user may have been deactivated inside the txn — clear auth cache.
    const db = getDb();
    const user = await db.user.findFirst({ where: { partyId: input.partyId, organizationId: session.orgId }, select: { id: true } });
    if (user) authStatusCache.delete(user.id);
    return { ok: true as const, status: 200 as const, data: { id: input.partyId, updatedAt: result.updatedAt.toISOString() } };
  } catch (err) {
    if (err instanceof StaleUpdateError) return { ok: false as const, status: 409, error: "Record changed — reloaded" };
    if (err instanceof InvalidStateError) return { ok: false as const, status: 409, error: err.message };
    if (err instanceof NotFoundError) return { ok: false as const, status: 404, error: "Agent not found" };
    throw err;
  }
}

export async function activateAgentService(
  session: PartiesSession,
  input: z.infer<typeof activateAgentSchema>,
) {
  const role = await findRole(session.orgId, input.partyId, "agent");
  if (!role) return { ok: false as const, status: 404, error: "Agent not found" };
  try {
    const result = await activateAgentTx(session.orgId, input.partyId, input.note, input.updatedAt, session.userId);
    return { ok: true as const, status: 200 as const, data: { id: input.partyId, updatedAt: result.updatedAt.toISOString() } };
  } catch (err) {
    if (err instanceof StaleUpdateError) return { ok: false as const, status: 409, error: "Record changed — reloaded" };
    if (err instanceof InvalidStateError) return { ok: false as const, status: 409, error: err.message };
    if (err instanceof NotFoundError) return { ok: false as const, status: 404, error: "Agent not found" };
    throw err;
  }
}

export async function getAgentDetailService(
  session: PartiesSession,
  partyId: string,
) {
  const partyRole = await findRole(session.orgId, partyId, "agent");
  if (!partyRole) return { ok: false as const, status: 404, error: "Agent not found" };
  const detail = await getAgentDetail(session.orgId, partyId);
  if (!detail) return { ok: false as const, status: 404, error: "Agent not found" };

  // Inject `formattedPhone` alongside `primaryPhone` so the agent detail
  // page renders a friendly display without pulling libphonenumber-js into
  // the client bundle. Repository shape is preserved otherwise.
  const detailWithPhone = withFormattedPhone(detail);

  // Role-aware strip: editors (Normal Admins) must not see commission-derived
  // stats on the agent detail page. `claimStats` carries submitted/approved/
  // paid/rejected counts plus `totalPaidCommission` — the monetary field is
  // the sensitive one. The route-level `requireRole("manager")` gate on this
  // module currently blocks editors from reaching this service, but we strip
  // here too as belt-and-braces so a future gate relaxation cannot silently
  // re-expose commission amounts.
  const callerRole = (session.role as AdminRole) ?? "editor";
  if (!canSeeCommission(callerRole)) {
    const { claimStats: _claimStats, ...rest } = detailWithPhone;
    void _claimStats;
    return { ok: true as const, status: 200 as const, data: rest };
  }
  return { ok: true as const, status: 200 as const, data: detailWithPhone };
}

export async function revokePortalAccessService(
  session: PartiesSession,
  input: z.infer<typeof revokePortalAccessSchema>,
) {
  try {
    const result = await revokePortalAccessTx(session.orgId, input.partyId, input.updatedAt, session.userId);
    // Invalidate auth cache SYNCHRONOUSLY after the DB write committed
    authStatusCache.delete(result.userId);
    return { ok: true as const, status: 200 as const, data: { ok: true } };
  } catch (err) {
    if (err instanceof StaleUpdateError) return { ok: false as const, status: 409, error: "Record changed — reloaded" };
    if (err instanceof NotFoundError) return { ok: false as const, status: 404, error: err.message };
    throw err;
  }
}

export async function getAgentHierarchyService(
  session: PartiesSession,
  opts: { includeDeactivated?: boolean } = {},
): Promise<HierarchyNode[]> {
  return getAgentHierarchy(session.orgId, opts.includeDeactivated ?? false);
}

export async function getAncestorsService(session: PartiesSession, partyId: string) {
  return getAncestors(session.orgId, partyId);
}

export async function getDownlinesService(
  session: PartiesSession,
  partyId: string,
  depth: string
) {
  return depth === "all"
    ? getSubtree(session.orgId, partyId)
    : getDirectDownlines(session.orgId, partyId);
}

export async function setUplineService(
  session: PartiesSession,
  partyId: string,
  newUplineId: string | null,
) {
  const result = await setUplineTx(session.orgId, partyId, newUplineId, session.userId);
  if (!result.ok) {
    const status = result.error === "NOT_FOUND" ? 404 : 400;
    return { ok: false as const, status, error: result.error };
  }
  return { ok: true as const, status: 200 as const, updatedAt: result.updatedAt };
}

export async function createPortalAccessService(
  session: { orgId: string },
  partyId: string,
  input: { email: string; password: string; fullName: string },
) {
  const db = getDb();

  const party = await db.party.findFirst({
    where: { id: partyId, organizationId: session.orgId },
    select: { id: true },
  });
  if (!party) return { ok: false as const, status: 404, error: "Party not found" };

  const role = await db.partyRole.findFirst({
    where: { partyId, organizationId: session.orgId, roleType: { in: ["owner", "tenant", "agent"] } },
    select: { id: true, roleType: true },
  });
  if (!role) return { ok: false as const, status: 400, error: "Party is not an owner, tenant, or agent" };

  const existing = await db.user.findFirst({
    where: { partyId, organizationId: session.orgId },
    select: { id: true },
  });
  if (existing) return { ok: false as const, status: 409, error: "Portal access already exists" };

  const emailTaken = await db.user.findFirst({
    where: { email: input.email.trim().toLowerCase(), organizationId: session.orgId },
    select: { id: true },
  });
  if (emailTaken) return { ok: false as const, status: 409, error: "Email already in use" };

  const passwordHash = await hashPassword(input.password);

  const user = await db.user.create({
    data: {
      organizationId: session.orgId,
      email: input.email.trim().toLowerCase(),
      fullName: input.fullName,
      passwordHash,
      status: "active",
      role: "viewer",
      userType: role.roleType, // "owner" | "tenant" | "agent"
      partyId,
      mustChangePassword: true,
    },
    select: { id: true },
  });

  return { ok: true as const, status: 201, data: { userId: user.id } };
}

export async function resetPortalPasswordService(
  session: { orgId: string; userId: string; role: string },
  partyId: string,
  input: { password: string },
): Promise<
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string }
> {
  if (!["admin", "manager"].includes(session.role)) {
    return { ok: false, status: 403, error: "Only manager+ can reset portal passwords" };
  }

  const db = getDb();
  const user = await db.user.findFirst({
    where: { partyId, organizationId: session.orgId },
    select: { id: true, organizationId: true },
  });
  if (!user) return { ok: false, status: 404, error: "Portal access does not exist for this party" };

  const passwordHash = await hashPassword(input.password);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePassword: true, status: "active" },
  });

  return { ok: true };
}

export type TenantSearchHit = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  formattedPhone: string | null;
  idType: string | null;
  idNumberMasked: string | null;
};

/**
 * Masked, name-only tenant search for the Inventory occupancy tenant picker.
 * The raw idNumber NEVER leaves this layer — only idNumberMasked (last-4).
 */
export async function searchTenantsService(
  session: PartiesSession,
  q: string | undefined,
  take?: number,
): Promise<{ data: TenantSearchHit[] }> {
  const clampedTake = Math.min(take ?? 20, 20);
  const rows = await searchTenants(session.orgId, q, clampedTake);
  const data = rows.map((r) => {
    const withPhone = withFormattedPhone(r);
    return {
      id: r.id,
      displayName: r.displayName,
      primaryPhone: withPhone.primaryPhone,
      formattedPhone: withPhone.formattedPhone,
      idType: r.idType,
      idNumberMasked: maskIdNumber(r.idNumber),
    };
  });
  return { data };
}

// ---------------------------------------------------------------------------
// Owner typeahead (M6 assign-owner picker)
// ---------------------------------------------------------------------------

export type OwnerSearchHit = {
  id: string;
  displayName: string;
  primaryPhone: string | null;
  formattedPhone: string | null;
};

/**
 * Slim owner typeahead for the assign-owner picker.
 * No IC / bank / blacklist fields — owners' PII must not leak through a
 * typeahead. Role filtering is enforced in searchOwners (roleType:"owner").
 */
export async function searchOwnersService(
  session: PartiesSession,
  q: string | undefined,
  take?: number,
): Promise<{ data: OwnerSearchHit[] }> {
  const clampedTake = Math.min(take ?? 20, 20);
  const rows = await searchOwners(session.orgId, q, clampedTake);
  const data = rows.map((r) => {
    const withPhone = withFormattedPhone(r);
    return {
      id: r.id,
      displayName: r.displayName,
      primaryPhone: withPhone.primaryPhone,
      formattedPhone: withPhone.formattedPhone,
    };
  });
  return { data };
}

export async function deletePartyByRoleService(
  session: PartiesSession,
  role: "tenant" | "owner",
  partyId: string,
) {
  const found = await findRole(session.orgId, partyId, role);
  if (!found) {
    return { ok: false as const, status: 404, error: role === "tenant" ? "Tenant not found" : "Owner not found" };
  }
  const shape = await loadPartyDeletionShape(session.orgId, partyId);
  if (!shape) {
    return { ok: false as const, status: 404, error: role === "tenant" ? "Tenant not found" : "Owner not found" };
  }
  const blockers = describeBlockers(shape);
  if (blockers.length) {
    return {
      ok: false as const,
      status: 409,
      error: `Cannot delete — ${blockers.join(", ")}. Blacklist or deactivate instead.`,
    };
  }
  try {
    await deletePartyTx({
      orgId: session.orgId,
      partyId,
      role,
      actorUserId: session.userId,
      displayName: shape.displayName,
      primaryEmail: shape.primaryEmail,
      primaryPhone: shape.primaryPhone,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false as const, status: 409, error: "Cannot delete — this record is still linked to other data." };
    }
    throw err;
  }
  return { ok: true as const, status: 200, data: { id: partyId } };
}
