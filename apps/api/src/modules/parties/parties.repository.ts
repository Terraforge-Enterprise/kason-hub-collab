import { getDb, Prisma } from "@kason/db";
import { StaleUpdateError, NotFoundError, InvalidStateError } from "../../lib/concurrency-error";
import { normalizeIc } from "../../lib/normalize-ic";
import type { HierarchyNode } from "./parties.types";

// ---------------------------------------------------------------------------
// Deletion-blocker helpers
// ---------------------------------------------------------------------------

const BLOCKER_LABELS = {
  tenancies: "tenancy",
  charges: "charge",
  payments: "payment",
  deposits: "deposit",
  bills: "bill",
  landlordTenancies: "property link",
  salesUnitsOwned: "sales unit",
  invoicesAsBillTo: "invoice",
  invoicesAsOwner: "owner invoice",
  managementFeeConfigs: "fee config",
} as const;

const PLURAL: Record<string, string> = {
  tenancy: "tenancies",
};

export type PartyDeletionShape = {
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  userAccount: { id: string } | null;
  _count: Record<keyof typeof BLOCKER_LABELS, number>;
};

export function describeBlockers(shape: PartyDeletionShape): string[] {
  const out: string[] = [];
  for (const key of Object.keys(BLOCKER_LABELS) as (keyof typeof BLOCKER_LABELS)[]) {
    const n = shape._count[key] ?? 0;
    if (n > 0) {
      const label = BLOCKER_LABELS[key];
      out.push(`${n} ${n > 1 ? (PLURAL[label] ?? label + "s") : label}`);
    }
  }
  if (shape.userAccount) out.push("a portal login");
  return out;
}

export function isPartyDeletable(shape: PartyDeletionShape): boolean {
  return describeBlockers(shape).length === 0;
}

const DELETION_SELECT = {
  displayName: true,
  primaryEmail: true,
  primaryPhone: true,
  userAccount: { select: { id: true } },
  _count: {
    select: {
      tenancies: true,
      charges: true,
      payments: true,
      deposits: true,
      bills: true,
      landlordTenancies: true,
      salesUnitsOwned: true,
      invoicesAsBillTo: true,
      invoicesAsOwner: true,
      managementFeeConfigs: true,
    },
  },
} as const;

export async function loadPartyDeletionShape(
  orgId: string,
  partyId: string,
): Promise<PartyDeletionShape | null> {
  const db = getDb();
  return db.party.findFirst({
    where: { id: partyId, organizationId: orgId },
    select: DELETION_SELECT,
  }) as Promise<PartyDeletionShape | null>;
}

export async function deletePartyTx(args: {
  orgId: string;
  partyId: string;
  role: "tenant" | "owner";
  actorUserId: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
}): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tx.activityLog.create({
      data: {
        organizationId: args.orgId,
        entityType: "party",
        entityId: args.partyId,
        action: args.role === "tenant" ? "tenant_deleted" : "owner_deleted",
        description: `Deleted ${args.role} ${args.displayName}`,
        performedBy: args.actorUserId,
        metadata: {
          displayName: args.displayName,
          primaryEmail: args.primaryEmail,
          primaryPhone: args.primaryPhone,
          role: args.role,
        },
      },
    });
    await tx.party.delete({ where: { id: args.partyId } });
  });
}

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

export async function listOwners(orgId: string) {
  const db = getDb();
  return db.party.findMany({
    where: { organizationId: orgId, roles: { some: { roleType: "owner" } } },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true, displayName: true, legalName: true, primaryEmail: true, primaryPhone: true,
      nationality: true, idType: true, idNumber: true,
      bankName: true, bankAccountHolder: true, bankAccountNumber: true,
      isBlacklisted: true, blacklistReason: true, status: true, createdAt: true, updatedAt: true,
      userAccount: { select: { id: true } },
      _count: {
        select: {
          tenancies: true, charges: true, payments: true, deposits: true, bills: true,
          landlordTenancies: true, salesUnitsOwned: true, invoicesAsBillTo: true,
          invoicesAsOwner: true, managementFeeConfigs: true,
        },
      },
      // Owned apartments → current property/unit for the records-table search.
      // Org-scoped (defence-in-depth). Deduped to distinct apartments in the
      // service (a partitioned apartment has many Listing rows sharing unitCode).
      ownedUnits: {
        where: { organizationId: orgId },
        select: {
          apartment: { select: { unitCode: true, property: { select: { name: true } } } },
        },
      },
    },
  });
}

export async function listTenants(orgId: string) {
  const db = getDb();
  return db.party.findMany({
    where: { organizationId: orgId, roles: { some: { roleType: "tenant" } } },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true, displayName: true, legalName: true, primaryEmail: true, primaryPhone: true,
      nationality: true, occupation: true, employerName: true, monthlyIncome: true,
      idType: true, idNumber: true,
      isBlacklisted: true, blacklistReason: true, status: true, createdAt: true, updatedAt: true,
      userAccount: { select: { id: true } },
      _count: {
        select: {
          tenancies: true, charges: true, payments: true, deposits: true, bills: true,
          landlordTenancies: true, salesUnitsOwned: true, invoicesAsBillTo: true,
          invoicesAsOwner: true, managementFeeConfigs: true, reservationsCreatedFrom: true,
        },
      },
      // Active tenancies → current property/unit for the records-table search.
      // Org-scoped (defence-in-depth) + active-only (current occupancy only).
      tenancies: {
        where: { organizationId: orgId, status: "active" },
        orderBy: { startDate: "desc" },
        select: {
          startDate: true,
          endDate: true,
          property: { select: { name: true } },
          unit: { select: { apartment: { select: { unitCode: true } } } },
        },
      },
    },
  });
}

/**
 * Full owner detail for the parties drawer. Scoped to `orgId` + `id`
 * with `roles: { some: { roleType: "owner" } }` so that a tenant/agent
 * partyId returns null (→ 404 at the service layer), matching the same
 * filter used by `listOwners`.
 */
export async function findOwnerDetail(orgId: string, partyId: string) {
  const db = getDb();
  return db.party.findFirst({
    where: {
      organizationId: orgId,
      id: partyId,
      roles: { some: { roleType: "owner" } },
    },
    select: {
      id: true,
      displayName: true,
      legalName: true,
      primaryEmail: true,
      primaryPhone: true,
      whatsappPhone: true,
      idType: true,
      idNumber: true,
      nationality: true,
      gender: true,
      dateOfBirth: true,
      occupation: true,
      employerName: true,
      employerAddress: true,
      monthlyIncome: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      emergencyContactRelation: true,
      bankName: true,
      bankAccountHolder: true,
      bankAccountNumber: true,
      isBlacklisted: true,
      blacklistReason: true,
      status: true,
      createdAt: true,
    },
  });
}

/**
 * Returns the DISTINCT apartments owned by this party for the "Portfolio →
 * Units owned" view. Scoped to the org so cross-org access is blocked.
 *
 * An owner owns a physical APARTMENT, but each apartment can carry many
 * Listing rows (PARTITIONED Master/Medium/Small rooms + carpark slots) that
 * all share the apartment's `unitCode`. Mapping per-listing would render one
 * owned apartment as "B-08-08, B-08-08, B-08-08, B-08-08", so we collapse to
 * distinct apartments (keyed by `apartmentId`).
 */
export async function findUnitsOwned(
  orgId: string,
  partyId: string,
): Promise<{ apartmentId: string; unitCode: string; propertyName: string }[]> {
  const db = getDb();
  const rows = await db.listing.findMany({
    where: { organizationId: orgId, ownerPartyId: partyId },
    select: {
      apartmentId: true,
      apartment: {
        select: { unitCode: true, property: { select: { name: true } } },
      },
    },
  });
  const seen = new Map<string, { apartmentId: string; unitCode: string; propertyName: string }>();
  for (const r of rows) {
    if (!seen.has(r.apartmentId)) {
      seen.set(r.apartmentId, {
        apartmentId: r.apartmentId,
        unitCode: r.apartment.unitCode,
        propertyName: r.apartment.property.name,
      });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.propertyName.localeCompare(b.propertyName) || a.unitCode.localeCompare(b.unitCode),
  );
}

/**
 * Full tenant detail for the parties drawer. Scoped to `orgId` + `id`
 * with `roles: { some: { roleType: "tenant" } }` so that an owner/agent
 * partyId returns null (→ 404 at the service layer), matching the same
 * filter used by `listTenants`.
 */
export async function findTenantDetail(orgId: string, partyId: string) {
  const db = getDb();
  return db.party.findFirst({
    where: {
      organizationId: orgId,
      id: partyId,
      roles: { some: { roleType: "tenant" } },
    },
    select: {
      id: true,
      displayName: true,
      legalName: true,
      primaryEmail: true,
      primaryPhone: true,
      whatsappPhone: true,
      idType: true,
      idNumber: true,
      nationality: true,
      gender: true,
      dateOfBirth: true,
      occupation: true,
      employerName: true,
      employerAddress: true,
      monthlyIncome: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      emergencyContactRelation: true,
      isBlacklisted: true,
      blacklistReason: true,
      status: true,
      createdAt: true,
    },
  });
}

export async function findTenantTenancyHistory(orgId: string, partyId: string) {
  return getDb().tenancy.findMany({
    where: { organizationId: orgId, tenantPartyId: partyId },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      tenancyCode: true,
      status: true,
      billingStatus: true,
      startDate: true,
      endDate: true,
      monthlyRentAmount: true,
      property: { select: { name: true } },
      unit: { select: { apartment: { select: { unitCode: true } } } },
    },
  });
}

/**
 * Tenant deposit ledger. Deposits are never retained by KAEN: every posted
 * collection is projected as `released_to_owner`, including partial payments.
 */
export async function findTenantDepositLedger(orgId: string, partyId: string) {
  const db = getDb();
  const [charges, transfers] = await Promise.all([
    db.charge.findMany({
      where: {
        organizationId: orgId,
        partyId,
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: { notIn: ["void", "credited"] },
      },
      orderBy: [{ dueDate: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        chargeNumber: true,
        chargeType: true,
        amount: true,
        outstandingAmount: true,
        dueDate: true,
        tenancyId: true,
        tenancy: {
          select: {
            tenancyCode: true,
            property: { select: { name: true } },
            unit: { select: { apartment: { select: { unitCode: true } } } },
          },
        },
      },
    }),
    db.deposit.groupBy({
      by: ["tenancyId", "type"],
      where: {
        organizationId: orgId,
        partyId,
        status: "released_to_owner",
      },
      _sum: { amount: true },
    }),
  ]);

  const transferredByLeg = new Map(
    transfers.map((row) => [
      `${row.tenancyId}:${row.type}`,
      Number(row._sum.amount?.toString() ?? 0),
    ]),
  );

  const ledger = new Map<string, {
    id: string;
    chargeNumber: string;
    type: "rental" | "utilities";
    expected: number;
    collected: number;
    outstanding: number;
    ownerTransferred: number;
    dueDate: Date;
    tenancyCode: string;
    propertyName: string;
    unitCode: string;
  }>();

  for (const charge of charges) {
    const type = charge.chargeType === "security_deposit" ? "rental" : "utilities";
    const expected = Number(charge.amount.toString());
    const outstanding = Number(charge.outstandingAmount.toString());
    const collected = Math.max(0, expected - outstanding);
    const key = `${charge.tenancyId ?? charge.id}:${type}`;
    const current = ledger.get(key);
    if (current) {
      current.expected += expected;
      current.collected += collected;
      current.outstanding += outstanding;
      current.chargeNumber = `${current.chargeNumber}, ${charge.chargeNumber}`;
      if (charge.dueDate > current.dueDate) current.dueDate = charge.dueDate;
      continue;
    }
    ledger.set(key, {
      id: key,
      chargeNumber: charge.chargeNumber,
      type,
      expected,
      collected,
      outstanding,
      ownerTransferred: charge.tenancyId
        ? Math.max(0, transferredByLeg.get(`${charge.tenancyId}:${type}`) ?? 0)
        : 0,
      dueDate: charge.dueDate,
      tenancyCode: charge.tenancy?.tenancyCode ?? "—",
      propertyName: charge.tenancy?.property.name ?? "—",
      unitCode: charge.tenancy?.unit.apartment.unitCode ?? "—",
    });
  }

  return [...ledger.values()].map((item) => ({
    ...item,
    ownerTransferred: Math.min(item.ownerTransferred, item.collected),
  }));
}

/**
 * Slim, name-only tenant typeahead for the Inventory occupancy picker.
 * Returns just enough to render a row + the masking source fields. The
 * service masks idNumber before it leaves the server.
 */
export async function searchTenants(orgId: string, q: string | undefined, take: number) {
  const db = getDb();
  // `normalizeIc` collapses a null/blank idNumber AND a punctuation-only query
  // (e.g. "-") to the same "" key -- every id-less Party ALSO has
  // idNumberNormalized === "". Only add the IC OR-branch when the normalized
  // query is non-empty, otherwise a blank/punctuation-only search would match
  // every id-less tenant org-wide (see Party.idNumberNormalized doc-comment).
  const normalizedQ = q ? normalizeIc(q) : "";
  return db.party.findMany({
    where: {
      organizationId: orgId,
      roles: { some: { roleType: "tenant" } },
      status: { not: "blacklisted" },
      ...(q
        ? { OR: [
            { displayName: { contains: q, mode: "insensitive" as const } },
            ...(normalizedQ !== "" ? [{ idNumberNormalized: normalizedQ }] : []),
          ] }
        : {}),
    },
    select: { id: true, displayName: true, primaryPhone: true, idType: true, idNumber: true },
    orderBy: { displayName: "asc" },
    take: Math.min(take, 20),
  });
}

/**
 * Slim owner typeahead for the assign-owner picker.
 * Returns only the fields needed for a list row — NO idNumber (owner IC must not
 * leak into a typeahead; owners are not screened the same way tenants are).
 */
export async function searchOwners(orgId: string, q: string | undefined, take: number) {
  const db = getDb();
  return db.party.findMany({
    where: {
      organizationId: orgId,
      roles: { some: { roleType: "owner" } },
      status: { not: "blacklisted" },
      ...(q ? { displayName: { contains: q, mode: "insensitive" as const } } : {}),
    },
    select: { id: true, displayName: true, primaryPhone: true },
    orderBy: { displayName: "asc" },
    take: Math.min(take, 20),
  });
}

/**
 * Returns true when the party has at least one Tenancy row in `status="active"`
 * scoped to the org. Used by the tenant detail endpoint to surface a warning
 * when a tenant lacks an active tenancy (portal login gate requires one).
 */
export async function hasActiveTenancy(orgId: string, partyId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.tenancy.findFirst({
    where: { organizationId: orgId, tenantPartyId: partyId, status: "active" },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Returns the portal User record linked to a party, or null if no login exists.
 * Used by detail endpoints to surface login status for admins.
 */
export async function findPortalUserByParty(orgId: string, partyId: string) {
  const db = getDb();
  return db.user.findFirst({
    where: { partyId, organizationId: orgId },
    select: { email: true, status: true, lastLoginAt: true, updatedAt: true },
  });
}

export async function findRole(orgId: string, partyId: string, roleType: "owner" | "tenant" | "agent") {
  const db = getDb();
  return db.partyRole.findFirst({ where: { organizationId: orgId, partyId, roleType }, select: { id: true } });
}

export async function findPartyByIdNumber(orgId: string, idNumber: string) {
  const db = getDb();
  return db.party.findFirst({ where: { organizationId: orgId, idNumber }, select: { id: true } });
}

export async function checkContactUniqueness(
  orgId: string,
  input: { email?: string | null; phone?: string | null; excludePartyId?: string },
): Promise<{ field: "email" | "phone"; party: { id: string; displayName: string } } | null> {
  const db = getDb();
  const notSelf = input.excludePartyId ? { id: { not: input.excludePartyId } } : {};
  if (input.email) {
    const hit = await db.party.findFirst({
      where: { organizationId: orgId, primaryEmail: { equals: input.email, mode: "insensitive" }, ...notSelf },
      select: { id: true, displayName: true },
    });
    if (hit) return { field: "email", party: hit };
  }
  if (input.phone) {
    const hit = await db.party.findFirst({
      where: { organizationId: orgId, primaryPhone: input.phone, ...notSelf },
      select: { id: true, displayName: true },
    });
    if (hit) return { field: "phone", party: hit };
  }
  return null;
}

export function isContactUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Maps a P2002 contact-uniqueness violation to the form field name so the race
// fallback can redden the right input. Prisma reports the violated constraint in
// `meta.target` — either the partial-unique index name (Party_org_email_unique /
// Party_org_phone_unique) or, depending on driver/version, a column-name array.
// Substring-matching on "email"/"phone" covers both shapes. Returns null when
// the field can't be determined, so callers keep the generic fallback message.
export function contactUniqueViolationField(err: unknown): "primaryEmail" | "primaryPhone" | null {
  if (!isContactUniqueViolation(err)) return null;
  const target = (err as Prisma.PrismaClientKnownRequestError).meta?.target;
  const hay = (Array.isArray(target) ? target.join(",") : String(target ?? "")).toLowerCase();
  if (hay.includes("email")) return "primaryEmail";
  if (hay.includes("phone")) return "primaryPhone";
  return null;
}

// Race fallback → a client-ready 409 descriptor. When the app-level pre-check
// misses a duplicate (concurrent create) the partial unique index rejects it
// with a P2002; this turns that raw error into the same { error, fieldErrors }
// shape the pre-check returns, so the offending input still turns red. Returns
// null for anything that isn't a contact P2002 so the caller rethrows.
export function describeContactViolation(
  err: unknown,
  subject: "owner" | "tenant",
): { status: 409; error: string; fieldErrors?: Record<string, string> } | null {
  if (!isContactUniqueViolation(err)) return null;
  const field = contactUniqueViolationField(err);
  const article = subject === "owner" ? "An owner" : "A tenant";
  const what = field === "primaryEmail" ? "email" : field === "primaryPhone" ? "phone number" : "phone or email";
  return {
    status: 409,
    error: `${article} with this ${what} already exists.`,
    ...(field ? { fieldErrors: { [field]: "Already in use" } } : {}),
  };
}

export async function createOwner(orgId: string, data: Record<string, unknown>) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const party = await tx.party.create({
      data: {
        organizationId: orgId,
        partyType: "owner",
        displayName: data.displayName as string,
        legalName: (data.legalName as string) || null,
        primaryEmail: (data.primaryEmail as string) || null,
        primaryPhone: (data.primaryPhone as string) || null,
        idType: (data.idType as string) || null,
        idNumber: (data.idNumber as string) || null,
        nationality: (data.nationality as string) || null,
        bankName: (data.bankName as string) || null,
        bankAccountHolder: (data.bankAccountHolder as string) || null,
        bankAccountNumber: (data.bankAccountNumber as string) || null,
        whatsappPhone: (data.whatsappPhone as string) || null,
        gender: (data.gender as string) || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth as string) : null,
        occupation: (data.occupation as string) || null,
        employerName: (data.employerName as string) || null,
        employerAddress: (data.employerAddress as string) || null,
        monthlyIncome: data.monthlyIncome ? Number(data.monthlyIncome as string) : null,
        emergencyContactName: (data.emergencyContactName as string) || null,
        emergencyContactPhone: (data.emergencyContactPhone as string) || null,
        emergencyContactRelation: (data.emergencyContactRelation as string) || null,
        status: "active",
      },
      // Inline-create consumers (Create Unit / Add Owner) immediately render a
      // confirmation card from this response. Returning only the id left that
      // card blank until the operator removed and searched for the owner again.
      select: {
        id: true,
        displayName: true,
        primaryPhone: true,
        primaryEmail: true,
      },
    });
    await tx.partyRole.create({ data: { organizationId: orgId, partyId: party.id, roleType: "owner", status: "active" } });
    return party;
  });
}

/**
 * TX-aware variant of createTenant. Inserts the Party + tenant PartyRole on
 * the supplied transaction client. Callers that need to chain additional
 * writes atomically (e.g. the tenant-create-from-reservation path, which
 * conditionally links UnitReservation.tenantPartyId in the same commit) can
 * pass their own `tx` so the whole write rolls back together — no orphan
 * Party if the extra write fails/rolls back.
 */
export async function createTenantTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: Record<string, unknown>,
) {
  const party = await tx.party.create({
    data: {
      organizationId: orgId,
      partyType: "tenant",
      displayName: data.displayName as string,
      legalName: (data.legalName as string) || null,
      primaryEmail: (data.primaryEmail as string) || null,
      primaryPhone: (data.primaryPhone as string) || null,
      idType: (data.idType as string) || null,
      idNumber: (data.idNumber as string) || null,
      nationality: (data.nationality as string) || null,
      whatsappPhone: (data.whatsappPhone as string) || null,
      gender: (data.gender as string) || null,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth as string) : null,
      occupation: (data.occupation as string) || null,
      employerName: (data.employerName as string) || null,
      employerAddress: (data.employerAddress as string) || null,
      monthlyIncome: data.monthlyIncome ? Number(data.monthlyIncome as string) : null,
      emergencyContactName: (data.emergencyContactName as string) || null,
      emergencyContactPhone: (data.emergencyContactPhone as string) || null,
      emergencyContactRelation: (data.emergencyContactRelation as string) || null,
      status: "active",
    },
    // The unit create/edit dialog immediately displays the newly-created
    // tenant without doing a second fetch. Return the same small identity
    // shape that the picker uses; returning only `id` left the selected tenant
    // visibly blank until the page was reloaded.
    select: {
      id: true,
      displayName: true,
      primaryPhone: true,
      idType: true,
    },
  });
  await tx.partyRole.create({ data: { organizationId: orgId, partyId: party.id, roleType: "tenant", status: "active" } });
  return party;
}

export async function createTenant(orgId: string, data: Record<string, unknown>) {
  const db = getDb();
  return db.$transaction((tx) => createTenantTx(tx, orgId, data));
}

export async function updateParty(
  partyId: string,
  expectedUpdatedAt: Date | string,
  data: Record<string, unknown>,
): Promise<{ updatedAt: Date } | null>;
export async function updateParty(
  partyId: string,
  data: Record<string, unknown>,
): Promise<void>;
export async function updateParty(
  partyId: string,
  expectedUpdatedAtOrData: Date | string | Record<string, unknown>,
  data?: Record<string, unknown>,
): Promise<{ updatedAt: Date } | null | void> {
  const db = getDb();
  // Overload: called with (partyId, data) — no concurrency check (owner/tenant paths)
  if (data === undefined) {
    await db.party.update({ where: { id: partyId }, data: expectedUpdatedAtOrData as Record<string, unknown> });
    return;
  }
  // Overload: called with (partyId, expectedUpdatedAt, data) — concurrency check (agent path)
  return updatePartyOnClient(db, partyId, expectedUpdatedAtOrData as Date | string, data);
}

/**
 * Tx-aware variant of updateParty's concurrency-checking path. Use this
 * inside a `db.$transaction` so the level/profile write commits atomically
 * with downstream writes (audit logs, upline restructures). Returns null
 * on stale-record conflict — caller decides whether to map that to 404 or 409.
 */
export function updatePartyTx(
  tx: Prisma.TransactionClient,
  partyId: string,
  expectedUpdatedAt: Date | string,
  data: Record<string, unknown>,
): Promise<{ updatedAt: Date } | null> {
  return updatePartyOnClient(tx, partyId, expectedUpdatedAt, data);
}

async function updatePartyOnClient(
  client: Prisma.TransactionClient | ReturnType<typeof getDb>,
  partyId: string,
  expectedUpdatedAt: Date | string,
  data: Record<string, unknown>,
): Promise<{ updatedAt: Date } | null> {
  try {
    const updated = await client.party.update({
      where: { id: partyId, updatedAt: new Date(expectedUpdatedAt) },
      data,
      select: { updatedAt: true },
    });
    return { updatedAt: updated.updatedAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return null;
    }
    throw err;
  }
}

export type ListAgentsFilter = {
  q?: string;
  take?: number;
  teamLeaderId?: string;
  teamScope?: "direct" | "indirect";
  /**
   * Restrict to agents whose agentLevel is one of the given values.
   * Used by the Managers list (`onlyLevel: ['leader']`).
   */
  onlyLevel?: string[];
  /**
   * Exclude agents whose agentLevel is one of the given values.
   * Used by the Agents list (`excludeLevel: ['leader']`) so managers stay out.
   */
  excludeLevel?: string[];
};

export async function listAgents(orgId: string, filter: ListAgentsFilter = {}) {
  const db = getDb();

  // Resolve the effective id set for teamScope=indirect via one raw CTE.
  // Defensive caps:
  //   - `depth <= 50` bounds recursion against accidental cycles / deep chains.
  //   - `UNION` (not UNION ALL) dedupes — cycle-safe at a small cost.
  //   - LIMIT caps the worst-case row-set size the API materialises.
  let idsFilter: { in: string[] } | undefined;
  if (filter.teamLeaderId && filter.teamScope === "indirect") {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `
      WITH RECURSIVE subtree AS (
        SELECT "id", 1 AS depth FROM "Party"
        WHERE "uplineId"::text = $2 AND "organizationId"::text = $1 AND "partyType" = 'agent'
        UNION
        SELECT p."id", s.depth + 1 FROM "Party" p
        JOIN subtree s ON p."uplineId" = s."id"
        WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND s.depth < 50
      )
      SELECT DISTINCT "id" FROM subtree
      LIMIT 5000
      `,
      orgId, filter.teamLeaderId,
    );
    idsFilter = { in: rows.map((r) => r.id) };
    if (idsFilter.in.length === 0) return [];
  }

  const levelWhere: Record<string, unknown> = {};
  if (filter.onlyLevel && filter.onlyLevel.length > 0) {
    levelWhere.agentLevel = { in: filter.onlyLevel };
  } else if (filter.excludeLevel && filter.excludeLevel.length > 0) {
    // SQL `NOT IN` evaluates to NULL for null rows, which would silently hide
    // agents whose level is unset. Keep those rows visible — they are not
    // leaders, so the "exclude leaders" filter should not drop them.
    levelWhere.OR = [
      { agentLevel: null },
      { agentLevel: { notIn: filter.excludeLevel } },
    ];
  }

  // Slim shape for typeahead (q present) — no PII beyond what's needed to pick a row.
  if (filter.q) {
    return db.party.findMany({
      where: {
        organizationId: orgId, partyType: "agent",
        displayName: { contains: filter.q, mode: "insensitive" as const },
        ...(filter.teamLeaderId && filter.teamScope !== "indirect"
          ? { uplineId: filter.teamLeaderId } : {}),
        ...(idsFilter ? { id: idsFilter } : {}),
        ...levelWhere,
      },
      select: { id: true, displayName: true, agentLevel: true, status: true },
      orderBy: { displayName: "asc" },
      take: Math.min(filter.take ?? 20, 20),
    });
  }

  // Full shape (admin table view).
  return db.party.findMany({
    where: {
      organizationId: orgId, partyType: "agent",
      ...(filter.teamLeaderId && filter.teamScope !== "indirect"
        ? { uplineId: filter.teamLeaderId } : {}),
      ...(idsFilter ? { id: idsFilter } : {}),
      ...levelWhere,
    },
    select: {
      id: true, displayName: true, legalName: true,
      primaryEmail: true, primaryPhone: true,
      nationality: true, isBlacklisted: true, status: true,
      agentLevel: true, createdAt: true, updatedAt: true,
      idType: true, idNumber: true,
      bankName: true, bankAccountHolder: true, bankAccountNumber: true,
      photoKey: true,
      userAccount: { select: { id: true, email: true, status: true, updatedAt: true } },
      uplineId: true,
      upline: { select: { id: true, displayName: true } },
    },
    orderBy: { displayName: "asc" },
    ...(filter.take ? { take: Math.min(filter.take, 500) } : {}),
  });
}

/**
 * Lookup any assignable member of the org — agents, managers, admins, super-admins.
 *
 * The Unit "in-charge" FK and the listing-visibility "hidden from" set both
 * reference `Party.id` regardless of partyType, but the legacy `/parties/agents`
 * typeahead filtered by `partyType = 'agent'`, leaving non-agent staff
 * invisible to the dialog. This function intentionally drops that filter so
 * the UI can pick anyone in the org.
 *
 * Slim shape (typeahead) — no PII, just enough to render a row + role hint.
 */
export async function listAssignableMembers(
  orgId: string,
  q: string | undefined,
  take = 20,
  // Optional partyType allow-list. The Unit dialog uses this to scope the
  // Sourcing-agent picker to `["agent"]` and the In-charge picker to
  // `["agent", "individual"]` — without it tenants and owners leak into
  // pickers they have no business in (client report 2026-05-22).
  partyTypes?: ReadonlyArray<string>,
) {
  const db = getDb();
  return db.party.findMany({
    where: {
      organizationId: orgId,
      // Exclude blacklisted parties — they should never be assignable.
      status: { not: "blacklisted" },
      ...(partyTypes && partyTypes.length > 0 ? { partyType: { in: [...partyTypes] } } : {}),
      ...(q ? { displayName: { contains: q, mode: "insensitive" as const } } : {}),
    },
    select: {
      id: true,
      displayName: true,
      agentLevel: true,
      partyType: true,
      status: true,
      // Reverse 1:1 to User. Operator parties (admin/manager/editor/viewer)
      // expose their concrete role here so the typeahead can label them
      // "manager" / "editor" instead of the generic "individual" partyType.
      // Null for agents, tenants, owners — they have no User row.
      userAccount: { select: { role: true } },
    },
    orderBy: { displayName: "asc" },
    take: Math.min(take, 50),
  });
}

/**
 * TX-aware variant of createAgent. Inserts the Party + agent PartyRole on
 * the supplied transaction client. Callers that need to chain additional
 * writes (e.g. minting an AgentCardVersion when a `title` is supplied)
 * can pass their own `tx` so everything stays atomic.
 */
export async function createAgentTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: Record<string, unknown>,
) {
  const party = await tx.party.create({
    data: {
      organizationId: orgId,
      partyType: "agent",
      displayName: data.displayName as string,
      legalName: data.legalName as string | undefined,
      primaryEmail: data.primaryEmail as string | undefined,
      primaryPhone: data.primaryPhone as string | undefined,
      idType: data.idType as string | undefined,
      idNumber: data.idNumber as string | undefined,
      nationality: data.nationality as string | undefined,
      bankName: data.bankName as string | undefined,
      bankAccountHolder: data.bankAccountHolder as string | undefined,
      bankAccountNumber: data.bankAccountNumber as string | undefined,
      agentLevel: data.agentLevel as string | undefined,
      status: "active",
    },
  });
  await tx.partyRole.create({
    data: {
      organizationId: orgId,
      partyId: party.id,
      roleType: "agent",
      status: "active",
    },
  });
  return party;
}

export async function createAgent(orgId: string, data: Record<string, unknown>) {
  const db = getDb();
  return db.$transaction((tx) => createAgentTx(tx, orgId, data));
}

export async function deactivateAgentTx(
  orgId: string,
  partyId: string,
  note: string,
  expectedUpdatedAt: string,
  performedBy: string,
): Promise<{ updatedAt: Date }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, organizationId: orgId },
      select: { displayName: true, status: true, isBlacklisted: true },
    });
    if (!party) throw new NotFoundError("agent");
    // Blacklist is the stronger state — refuse to "soften" it to plain inactive.
    // The user must explicitly reactivate-from-blacklist (which un-blacklists) first.
    if (party.isBlacklisted) throw new InvalidStateError("IS_BLACKLISTED", "Agent is blacklisted — use reactivate to un-blacklist");
    if (party.status === "inactive") throw new InvalidStateError("ALREADY_INACTIVE", "Agent is already inactive");

    let updated: { updatedAt: Date };
    try {
      updated = await tx.party.update({
        where: { id: partyId, updatedAt: new Date(expectedUpdatedAt) },
        data: { status: "inactive" },
        select: { updatedAt: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new StaleUpdateError();
      }
      throw err;
    }

    // Deactivate linked portal user(s) so they cannot log in during the inactive period.
    // Unlike blacklist, we do NOT reject pending commission claims or detach downlines —
    // this is a soft retirement, not a punitive action.
    await tx.user.updateMany({
      where: { partyId, organizationId: orgId },
      data: { status: "inactive" },
    });

    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "party",
        entityId: partyId,
        action: "deactivated",
        description: `Agent ${party.displayName} deactivated`,
        performedBy,
        metadata: { note },
      },
    });

    return { updatedAt: updated.updatedAt };
  });
}

export async function activateAgentTx(
  orgId: string,
  partyId: string,
  note: string,
  expectedUpdatedAt: string,
  performedBy: string,
): Promise<{ updatedAt: Date }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const party = await tx.party.findFirst({
      where: { id: partyId, organizationId: orgId },
      select: { displayName: true, status: true, isBlacklisted: true },
    });
    if (!party) throw new NotFoundError("agent");
    // Blacklisted agents use the dedicated reactivate flow — keep audit trails distinct.
    if (party.isBlacklisted) throw new InvalidStateError("IS_BLACKLISTED", "Agent is blacklisted — use reactivate instead");
    if (party.status === "active") throw new InvalidStateError("ALREADY_ACTIVE", "Agent is already active");

    let updated: { updatedAt: Date };
    try {
      updated = await tx.party.update({
        where: { id: partyId, updatedAt: new Date(expectedUpdatedAt) },
        data: { status: "active" },
        select: { updatedAt: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new StaleUpdateError();
      }
      throw err;
    }

    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "party",
        entityId: partyId,
        action: "activated",
        description: `Agent ${party.displayName} activated`,
        performedBy,
        metadata: { note },
      },
    });

    return { updatedAt: updated.updatedAt };
  });
}

export async function reactivateAgentTx(
  orgId: string,
  partyId: string,
  note: string,
  expectedUpdatedAt: string,
  performedBy: string,
): Promise<{ updatedAt: Date }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // 1. Fetch displayName and current blacklist status (tenant isolation via findFirst+orgId)
    const party = await tx.party.findFirst({
      where: { id: partyId, organizationId: orgId },
      select: { displayName: true, isBlacklisted: true },
    });
    if (!party) throw new NotFoundError("agent");
    if (!party.isBlacklisted) throw new InvalidStateError("NOT_BLACKLISTED", "Agent is not blacklisted");

    // 2. Atomic update with updatedAt check
    let updated: { updatedAt: Date };
    try {
      updated = await tx.party.update({
        where: { id: partyId, updatedAt: new Date(expectedUpdatedAt) },
        data: { isBlacklisted: false, blacklistReason: null, status: "active" },
        select: { updatedAt: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new StaleUpdateError();
      }
      throw err;
    }

    // 3. ActivityLog write inside the transaction
    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "party",
        entityId: partyId,
        action: "reactivated",
        description: `Agent ${party.displayName} reactivated`,
        performedBy,
        metadata: { note },
      },
    });

    return { updatedAt: updated.updatedAt };
  });
}

export async function getAgentDetail(orgId: string, partyId: string) {
  const db = getDb();
  const party = await db.party.findFirst({
    where: { id: partyId, organizationId: orgId },
    select: {
      id: true, displayName: true, legalName: true,
      primaryEmail: true, primaryPhone: true, idType: true, idNumber: true,
      nationality: true, agentLevel: true,
      bankName: true, bankAccountHolder: true, bankAccountNumber: true,
      status: true, isBlacklisted: true, blacklistReason: true,
      createdAt: true, updatedAt: true,
      userAccount: { select: { id: true, email: true, lastLoginAt: true, status: true, updatedAt: true } },
    },
  });
  if (!party) return null;

  // One groupBy for all five stats
  const grouped = await db.commissionClaim.groupBy({
    by: ["status"],
    where: { organizationId: orgId, agentPartyId: partyId },
    _count: { _all: true },
    _sum: { totalNettPayout: true },
  });

  const stats = { submitted: 0, approved: 0, paid: 0, rejected: 0, totalPaidCommission: 0 };
  for (const row of grouped) {
    if (row.status === "submitted") stats.submitted = row._count._all;
    else if (row.status === "approved") stats.approved = row._count._all;
    else if (row.status === "paid") {
      stats.paid = row._count._all;
      stats.totalPaidCommission = Number(row._sum.totalNettPayout ?? 0);
    } else if (row.status === "rejected") stats.rejected = row._count._all;
    // draft — not surfaced on the detail page
  }

  return {
    id: party.id,
    displayName: party.displayName,
    legalName: party.legalName,
    primaryEmail: party.primaryEmail,
    primaryPhone: party.primaryPhone,
    idType: party.idType,
    idNumber: party.idNumber,
    nationality: party.nationality,
    agentLevel: party.agentLevel,
    bank: {
      name: party.bankName,
      accountHolder: party.bankAccountHolder,
      accountNumber: party.bankAccountNumber,
    },
    status: party.status,
    isBlacklisted: party.isBlacklisted,
    blacklistReason: party.blacklistReason,
    portalUser: party.userAccount
      ? {
          id: party.userAccount.id,
          email: party.userAccount.email,
          lastLoginAt: party.userAccount.lastLoginAt?.toISOString() ?? null,
          status: party.userAccount.status,
          updatedAt: party.userAccount.updatedAt.toISOString(),
        }
      : null,
    claimStats: stats,
    createdAt: party.createdAt.toISOString(),
    updatedAt: party.updatedAt.toISOString(),
  };
}

export async function revokePortalAccessTx(
  orgId: string,
  partyId: string,
  expectedUpdatedAt: string,
  performedBy: string,
): Promise<{ userId: string }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { partyId, organizationId: orgId },
      select: { id: true, updatedAt: true, email: true },
    });
    if (!user) throw new NotFoundError("portal user", "Portal user not found for this party");

    if (user.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new StaleUpdateError();
    }

    // Hard revoke: delete the User credential row entirely so the agent can be
    // re-granted access cleanly. The Agent (Party) is untouched. If FK
    // restrictions block the delete (audit/IC/grant log entries from a prior
    // operator-side life — rare for agent-role users), fall back to scrubbing
    // the row: unlink from party, free the email, mark status. Either way,
    // `getAgentDetail.portalUser` becomes null and grant works again.
    try {
      await tx.user.delete({ where: { id: user.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        const scrubbedEmail = `${user.email}:revoked:${Date.now()}`;
        await tx.user.update({
          where: { id: user.id },
          data: { partyId: null, status: "revoked", email: scrubbedEmail },
        });
      } else {
        throw err;
      }
    }

    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "user",
        entityId: user.id,
        action: "portal_access_revoked",
        description: `Portal access revoked for party ${partyId}`,
        performedBy,
        metadata: { partyId },
      },
    });

    return { userId: user.id };
  });
}

export async function blacklistAgentTx(
  orgId: string,
  partyId: string,
  reason: string,
  expectedUpdatedAt: Date | string,
  performedBy: string,
): Promise<{ updatedAt: Date; detachedDownlineIds: string[] }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // 1. Fetch displayName for the activity log description
    const party = await tx.party.findUnique({
      where: { id: partyId },
      select: { displayName: true },
    });
    const displayName = party?.displayName ?? partyId;

    // 2. Blacklist the party — concurrency check via updatedAt (atomic: update returns the row)
    let fresh: { updatedAt: Date };
    try {
      fresh = await tx.party.update({
        where: { id: partyId, updatedAt: new Date(expectedUpdatedAt) },
        data: { isBlacklisted: true, blacklistReason: reason, status: "inactive" },
        select: { updatedAt: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new StaleUpdateError();
      }
      throw err;
    }

    // 4. Deactivate portal users linked to this party
    await tx.user.updateMany({
      where: { partyId },
      data: { status: "inactive" },
    });

    // 5. Collect draft+pending claim IDs before rejecting them
    const claimsToReject = await tx.commissionClaim.findMany({
      where: { agentPartyId: partyId, status: { in: ["draft", "pending"] } },
      select: { id: true },
    });
    const autoRejectedClaimIds = claimsToReject.map((c) => c.id);

    // 6. Reject those claims
    await tx.commissionClaim.updateMany({
      where: { agentPartyId: partyId, status: { in: ["draft", "pending"] } },
      data: { status: "rejected", rejectionReason: "Agent blacklisted", rejectedAt: new Date() },
    });

    // 7. Detach direct downlines — set uplineId to null for all direct reports
    const downlines = await tx.party.findMany({
      where: { organizationId: orgId, uplineId: partyId, partyType: "agent" },
      select: { id: true },
    });

    if (downlines.length > 0) {
      await tx.party.updateMany({
        where: { organizationId: orgId, uplineId: partyId, partyType: "agent" },
        data: { uplineId: null },
      });
      await tx.activityLog.createMany({
        data: downlines.map((d) => ({
          organizationId: orgId,
          entityType: "party",
          entityId: d.id,
          action: "upline_detached_on_blacklist",
          description: `Upline ${partyId} blacklisted — detached`,
          performedBy,
          metadata: { originalUplineId: partyId },
        })),
      });
    }

    // 8. Write the activity log — inside transaction so it rolls back atomically
    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "party",
        entityId: partyId,
        action: "blacklisted",
        description: `Agent ${displayName} blacklisted`,
        performedBy,
        metadata: { reason, autoRejectedClaimIds },
      },
    });

    return { updatedAt: fresh.updatedAt, detachedDownlineIds: downlines.map((d) => d.id) };
  });
}

export type AncestorRow = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  uplineId: string | null;
};

export async function getAncestors(orgId: string, partyId: string): Promise<AncestorRow[]> {
  const db = getDb();
  // UNION (not UNION ALL) deduplicates — defends against malformed cycles
  // in legacy data causing exponential row counts. Depth capped at 20 to
  // match spec §4.2 invariant (inclusive).
  return db.$queryRawUnsafe<AncestorRow[]>(
    `
    WITH RECURSIVE chain AS (
      SELECT "id", "displayName", "agentLevel", "uplineId", 0 AS depth
      FROM "Party"
      WHERE "id"::text = $2 AND "organizationId"::text = $1
        AND "partyType" = 'agent'
      UNION
      SELECT p."id", p."displayName", p."agentLevel", p."uplineId", c.depth + 1
      FROM "Party" p
      JOIN chain c ON c."uplineId" = p."id"
      WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND c.depth < 20
    )
    SELECT "id", "displayName", "agentLevel", "uplineId"
    FROM chain
    ORDER BY depth DESC
    `,
    orgId,
    partyId
  );
}

export type DownlineRow = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  status: string;
  uplineId: string | null;
};

export async function getDirectDownlines(orgId: string, uplineId: string): Promise<DownlineRow[]> {
  const db = getDb();
  return db.party.findMany({
    where: { organizationId: orgId, uplineId, partyType: "agent" },
    select: { id: true, displayName: true, agentLevel: true, status: true, uplineId: true },
    orderBy: { displayName: "asc" },
  });
}

export async function getSubtree(orgId: string, rootId: string): Promise<DownlineRow[]> {
  const db = getDb();
  // UNION (not UNION ALL) dedups — prevents exponential blow-up if legacy data has cycles.
  return db.$queryRawUnsafe<DownlineRow[]>(
    `
    WITH RECURSIVE subtree AS (
      SELECT "id", "displayName", "agentLevel", "status", "uplineId", 0 AS depth
      FROM "Party"
      WHERE "uplineId"::text = $2 AND "organizationId"::text = $1
        AND "partyType" = 'agent'
      UNION
      SELECT p."id", p."displayName", p."agentLevel", p."status", p."uplineId", s.depth + 1
      FROM "Party" p
      JOIN subtree s ON p."uplineId" = s."id"
      WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND s.depth < 20
    )
    SELECT "id", "displayName", "agentLevel", "status", "uplineId"
    FROM subtree
    ORDER BY "displayName" ASC
    `,
    orgId,
    rootId
  );
}

export async function validateUplineChange(
  orgId: string,
  partyId: string,
  newUplineId: string | null,
): Promise<{ ok: true } | { ok: false; error:
    "UPLINE_SELF_REFERENCE" | "UPLINE_INVALID_TARGET"
    | "UPLINE_WOULD_CREATE_CYCLE" | "UPLINE_DEPTH_EXCEEDED" | "NOT_FOUND" }> {
  if (newUplineId === null) return { ok: true };
  if (newUplineId === partyId) return { ok: false, error: "UPLINE_SELF_REFERENCE" };

  const db = getDb();

  const self = await db.party.findFirst({
    where: { id: partyId, organizationId: orgId },
    select: { partyType: true },
  });
  if (!self || self.partyType !== "agent") return { ok: false, error: "NOT_FOUND" };

  const target = await db.party.findFirst({
    where: { id: newUplineId, organizationId: orgId },
    select: { partyType: true, status: true },
  });
  // Uplines may be agents OR staff individuals (admins/managers/editors).
  // Tenants/owners are NOT eligible. Blacklisted uplines are also rejected.
  const ELIGIBLE_UPLINE_TYPES = new Set(["agent", "individual"]);
  if (
    !target ||
    !ELIGIBLE_UPLINE_TYPES.has(target.partyType) ||
    target.status === "blacklisted"
  ) {
    return { ok: false, error: "UPLINE_INVALID_TARGET" };
  }

  const cycle = await db.$queryRawUnsafe<{ id: string }[]>(
    `
    WITH RECURSIVE subtree AS (
      SELECT "id", "uplineId", 0 AS depth FROM "Party"
      WHERE "uplineId"::text = $2 AND "organizationId"::text = $1 AND "partyType" = 'agent'
      UNION
      SELECT p."id", p."uplineId", s.depth + 1 FROM "Party" p
      JOIN subtree s ON p."uplineId" = s."id"
      WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND s.depth < $3
    )
    SELECT "id" FROM subtree WHERE "id"::text = $4
    LIMIT 1
    `,
    orgId, partyId, MAX_HIERARCHY_DEPTH, newUplineId,
  );
  if (cycle.length > 0) return { ok: false, error: "UPLINE_WOULD_CREATE_CYCLE" };

  const ancestors = await db.$queryRawUnsafe<{ cnt: number }[]>(
    `
    WITH RECURSIVE chain AS (
      SELECT "id", "uplineId", 0 AS depth FROM "Party"
      WHERE "id"::text = $2 AND "organizationId"::text = $1 AND "partyType" = 'agent'
      UNION
      SELECT p."id", p."uplineId", c.depth + 1 FROM "Party" p
      JOIN chain c ON c."uplineId" = p."id"
      WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND c.depth < $3
    )
    SELECT COUNT(DISTINCT "id")::int AS cnt FROM chain
    `,
    orgId, newUplineId, MAX_HIERARCHY_DEPTH,
  );
  if ((ancestors[0]?.cnt ?? 0) + 1 > MAX_HIERARCHY_DEPTH) {
    return { ok: false, error: "UPLINE_DEPTH_EXCEEDED" };
  }

  return { ok: true };
}

export async function getPartyById(orgId: string, id: string) {
  const db = getDb();
  return db.party.findFirst({
    where: { id, organizationId: orgId },
    select: {
      id: true, organizationId: true, partyType: true, status: true, uplineId: true,
    },
  });
}

export type SetUplineResult =
  | { ok: true; updatedAt: Date; changed: boolean }
  | { ok: false; error:
      | "UPLINE_SELF_REFERENCE" | "UPLINE_INVALID_TARGET"
      | "UPLINE_WOULD_CREATE_CYCLE" | "UPLINE_DEPTH_EXCEEDED" | "NOT_FOUND" };

const MAX_HIERARCHY_DEPTH = 20;

export async function setUplineTx(
  orgId: string,
  partyId: string,
  newUplineId: string | null,
  performedBy: string,
): Promise<SetUplineResult> {
  const db = getDb();
  return db.$transaction<SetUplineResult>(async (tx) => {
    if (newUplineId === partyId) return { ok: false, error: "UPLINE_SELF_REFERENCE" };

    const self = await tx.party.findFirst({
      where: { id: partyId, organizationId: orgId },
      select: { id: true, organizationId: true, partyType: true, uplineId: true },
    });
    // Self may be agent OR staff individual — both legitimately appear in
    // the reporting tree and can be re-parented. Tenants/owners cannot.
    if (!self || (self.partyType !== "agent" && self.partyType !== "individual")) {
      return { ok: false, error: "NOT_FOUND" };
    }

    // No-op guard — avoid ActivityLog flood if admin saved the form without changing upline.
    if (self.uplineId === newUplineId) {
      const row = await tx.party.findUnique({
        where: { id: partyId },
        select: { updatedAt: true },
      });
      return { ok: true, updatedAt: row!.updatedAt, changed: false };
    }

    if (newUplineId !== null) {
      // Scope target lookup to the actor's org so cross-org existence is NOT
      // distinguishable from "doesn't exist" — closes enumeration oracle.
      const target = await tx.party.findFirst({
        where: { id: newUplineId, organizationId: orgId },
        select: { partyType: true, status: true },
      });
      // Uplines may be agents OR staff individuals (admins/managers/editors).
      // Tenants/owners are NOT eligible. Blacklisted uplines also rejected.
      if (
        !target ||
        (target.partyType !== "agent" && target.partyType !== "individual") ||
        target.status === "blacklisted"
      ) {
        return { ok: false, error: "UPLINE_INVALID_TARGET" };
      }

      // Cycle check with explicit depth guard — defends against malformed
      // legacy data from hand-inserted rows that bypassed the invariant.
      const cycle = await tx.$queryRawUnsafe<{ id: string }[]>(
        `
        WITH RECURSIVE subtree AS (
          SELECT "id", "uplineId", 0 AS depth FROM "Party"
          WHERE "uplineId"::text = $2 AND "organizationId"::text = $1 AND "partyType" = 'agent'
          UNION
          SELECT p."id", p."uplineId", s.depth + 1 FROM "Party" p
          JOIN subtree s ON p."uplineId" = s."id"
          WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND s.depth < $3
        )
        SELECT "id" FROM subtree WHERE "id"::text = $4
        LIMIT 1
        `,
        orgId, partyId, MAX_HIERARCHY_DEPTH, newUplineId,
      );
      if (cycle.length > 0) return { ok: false, error: "UPLINE_WOULD_CREATE_CYCLE" };

      // Depth check: count ancestors of newUplineId. DISTINCT id so a cycle
      // can't inflate the count.
      const ancestors = await tx.$queryRawUnsafe<{ cnt: number }[]>(
        `
        WITH RECURSIVE chain AS (
          SELECT "id", "uplineId", 0 AS depth FROM "Party"
          WHERE "id"::text = $2 AND "organizationId"::text = $1 AND "partyType" = 'agent'
          UNION
          SELECT p."id", p."uplineId", c.depth + 1 FROM "Party" p
          JOIN chain c ON c."uplineId" = p."id"
          WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND c.depth < $3
        )
        SELECT COUNT(DISTINCT "id")::int AS cnt FROM chain
        `,
        orgId, newUplineId, MAX_HIERARCHY_DEPTH,
      );
      if ((ancestors[0]?.cnt ?? 0) + 1 > MAX_HIERARCHY_DEPTH) {
        return { ok: false, error: "UPLINE_DEPTH_EXCEEDED" };
      }
    }

    const updated = await tx.party.update({
      where: { id: partyId },
      data: { uplineId: newUplineId },
      select: { updatedAt: true, displayName: true },
    });

    // Resolve display names for a human-readable audit description.
    const [fromName, toName] = await Promise.all([
      self.uplineId
        ? tx.party.findUnique({ where: { id: self.uplineId }, select: { displayName: true } })
        : Promise.resolve(null),
      newUplineId
        ? tx.party.findUnique({ where: { id: newUplineId }, select: { displayName: true } })
        : Promise.resolve(null),
    ]);

    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "party",
        entityId: partyId,
        action: "upline_changed",
        description: `Upline changed: "${fromName?.displayName ?? "none"}" → "${toName?.displayName ?? "none"}"`,
        performedBy,
        metadata: { from: self.uplineId ?? null, to: newUplineId },
      },
    });
    return { ok: true, updatedAt: updated.updatedAt, changed: true };
  });
}

/**
 * Returns a flat list of every agent in the org plus their direct downline
 * count. The tree shape is reconstructed on the client from `uplineId`.
 *
 * Defensive caps (DoS hardening — see systematic-debugging review):
 *   - MAX_HIERARCHY_ROWS limits the payload to a size the browser can render.
 *   - Single non-recursive query — no CTE recursion here, so no runaway depth.
 *     (The recursive walk happens on the client, which is already cycle-safe.)
 *   - Index: `@@index([organizationId, uplineId])` on Party keeps the
 *     direct-counts subquery cheap at scale.
 *
 * If an org ever crosses MAX_HIERARCHY_ROWS we should switch the UI to a
 * lazy-load-by-subtree model rather than lifting the cap.
 */
const MAX_HIERARCHY_ROWS = 5000;

export async function getAgentHierarchy(
  orgId: string,
  includeDeactivated = false,
): Promise<HierarchyNode[]> {
  const db = getDb();
  // Default hides inactive (deactivated + blacklisted) agents from the tree so
  // the active org chart is clean. `includeDeactivated=true` returns everyone
  // and lets the UI distinguish them with muted styling.
  const statusFilter = includeDeactivated ? "" : `AND p."status" = 'active'`;
  const directCountFilter = includeDeactivated
    ? ""
    : `AND "status" = 'active'`;
  // Org chart includes BOTH agents AND staff individuals (admins / managers /
  // editors / viewers). Tenants and owners are excluded — they're parties
  // but not part of the org. Staff appear regardless of whether they have
  // any agent downlines so newly-created operator users surface immediately
  // under the synthetic KAEN Properties root.
  return db.$queryRawUnsafe<HierarchyNode[]>(
    `
    WITH direct_counts AS (
      SELECT "uplineId" AS parent_id, COUNT(*)::int AS cnt
      FROM "Party"
      WHERE "organizationId"::text = $1
        AND "partyType" IN ('agent', 'individual')
        AND "uplineId" IS NOT NULL
        ${directCountFilter}
      GROUP BY "uplineId"
    )
    SELECT
      p."id",
      p."displayName",
      p."agentLevel",
      p."status",
      p."uplineId",
      p."partyType",
      -- For staff individuals, surface the linked User's role so the chart
      -- can color-code and label by role (admin / manager / editor / viewer)
      -- instead of a generic "staff". NULL for agents (User.partyId points
      -- to them but their role is always 'viewer' — not meaningful here).
      CASE WHEN p."partyType" = 'individual' THEN u.role ELSE NULL END AS "userRole",
      COALESCE(dc.cnt, 0) AS "directDownlineCount"
    FROM "Party" p
    LEFT JOIN direct_counts dc ON dc.parent_id = p."id"
    LEFT JOIN "User" u ON u."partyId" = p."id" AND u."organizationId"::text = $1
    WHERE p."organizationId"::text = $1
      AND p."partyType" IN ('agent', 'individual')
      ${statusFilter}
    ORDER BY p."displayName" ASC
    LIMIT ${MAX_HIERARCHY_ROWS}
    `,
    orgId
  );
}
