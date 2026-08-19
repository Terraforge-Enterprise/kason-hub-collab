import { getDb, Prisma } from "@kason/db";
import { ymOfUtc } from "@kason/shared";
import type { AdminRole } from "../../lib/rbac";
import { tenancyPeriodWhere, type TenancyPeriodWhere } from "../../lib/tenancy-period";

export function firstOfMonthUtc(ym: string): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

export function compactMonth(ym: string): string {
  return ym.replace("-", "");
}

export function tenantInvoiceNumber(ym: string, tenancyId: string): string {
  return `TR-${compactMonth(ym)}-${tenancyId.slice(0, 8)}`;
}

// Deterministic rent charge number. Uses the FULL tenancyId (not a slice) so the
// auto-draft cron and the tracker's unified post (post-monthly-rent.ts) converge on
// ONE format → Charge @@unique(organizationId, chargeNumber) dedups rent across both
// paths (a month's rent is never double-posted). Must stay byte-identical to the
// number built in postMonthlyRentForTenancy.
export function rentChargeNumber(ym: string, tenancyId: string): string {
  return `RENT-${compactMonth(ym)}-${tenancyId}`;
}

export async function getDraftConfig(orgId: string) {
  return getDb().draftConfig.findUnique({ where: { organizationId: orgId } });
}

export async function createDraftConfig(
  orgId: string,
  input: {
    runDayOfMonth: number;
    dueDayOffset?: number | null;
    includeRent?: boolean;
    includeElectricity?: boolean;
    includeMgmtFee?: boolean;
    includeCleaning?: boolean;
  },
) {
  return getDb().draftConfig.create({
    data: {
      organizationId: orgId,
      runDayOfMonth: input.runDayOfMonth,
      dueDayOffset: input.dueDayOffset ?? null,
      ...(input.includeRent !== undefined ? { includeRent: input.includeRent } : {}),
      ...(input.includeElectricity !== undefined ? { includeElectricity: input.includeElectricity } : {}),
      ...(input.includeMgmtFee !== undefined ? { includeMgmtFee: input.includeMgmtFee } : {}),
      ...(input.includeCleaning !== undefined ? { includeCleaning: input.includeCleaning } : {}),
    },
  });
}

// Resolve a REAL user for system-cron audit: the org's earliest-created admin.
// AuditLog.actorUserId is a non-null FK, so a sentinel string is impossible.
export async function resolveSystemActor(
  orgId: string,
): Promise<{ actorUserId: string; actorRole: AdminRole } | null> {
  const admin = await getDb().user.findFirst({
    where: { organizationId: orgId, role: "admin" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return admin ? { actorUserId: admin.id, actorRole: "admin" } : null;
}

/**
 * Org-scoped selection of the tenancies that OCCUPIED `month`.
 *
 * Replaces a `status: "active"` filter that carried no period at all. That filter
 * billed whoever occupies the unit today for whatever month the cron happened to
 * be running: a replacement tenancy starting next month prorated to RM0.00, while
 * the tenancy that actually lived there — now `ended` — was never billed for its
 * days. Both failures are silent. See lib/tenancy-period.ts.
 */
export function tenanciesForPeriodWhere(
  orgId: string,
  month: Date,
): { organizationId: string } & TenancyPeriodWhere {
  return { organizationId: orgId, ...tenancyPeriodWhere(month) };
}

/**
 * Every tenancy with occupied days in `month` — possibly MORE THAN ONE for a unit
 * when a handover happened mid-month. The caller bills each its own prorated
 * share (resolveMonthlyRentAmount already prorates per tenancy).
 */
export async function listTenanciesForPeriod(orgId: string, month: Date) {
  return getDb().tenancy.findMany({
    where: tenanciesForPeriodWhere(orgId, month),
    select: { id: true, unitId: true, tenantPartyId: true, propertyId: true, monthlyRentAmount: true, startDate: true, endDate: true, firstMonthIsCommission: true },
  });
}

export async function findExistingDraft(tx: Prisma.TransactionClient, orgId: string, idemKey: string) {
  return tx.invoice.findFirst({ where: { organizationId: orgId, idempotencyKey: idemKey }, select: { id: true, status: true } });
}

export async function findUnbilledTenantCharges(tx: Prisma.TransactionClient, orgId: string, tenancyId: string, firstOfMonth: Date, chargeTypes: string[]) {
  return tx.charge.findMany({
    where: { organizationId: orgId, tenancyId, billingMonth: firstOfMonth, invoiceId: null, status: "draft", chargeType: { in: chargeTypes } },
    select: { id: true, amount: true },
  });
}

export async function createInvoiceTx(tx: Prisma.TransactionClient, data: {
  orgId: string; invoiceNumber: string; partyId: string; tenancyId: string; propertyId: string;
  invoiceType: string; invoiceDate: Date; dueDate: Date | null; periodMonth: Date; idempotencyKey: string;
}) {
  return tx.invoice.create({
    data: {
      organizationId: data.orgId, invoiceNumber: data.invoiceNumber, partyId: data.partyId, tenancyId: data.tenancyId,
      propertyId: data.propertyId, invoiceType: data.invoiceType, status: "draft", invoiceDate: data.invoiceDate,
      dueDate: data.dueDate, periodMonth: data.periodMonth, totalAmount: "0.00", currency: "MYR", idempotencyKey: data.idempotencyKey,
    },
    select: { id: true },
  });
}

export async function createRentChargeTx(tx: Prisma.TransactionClient, data: {
  orgId: string; chargeNumber: string; tenancyId: string; unitId: string; partyId: string;
  amount: string; dueDate: Date; billingMonth: Date; invoiceId: string;
  chargeType?: "rent" | "letting_commission";
}) {
  // Commission month → KAEN revenue on IVTEN; every other month → owner rent (RB). The caller
  // decides via the shared monthlyChargeType so the draft agrees with the tracker poster.
  const chargeType = data.chargeType ?? "rent";
  return tx.charge.create({
    data: {
      organizationId: data.orgId, chargeNumber: data.chargeNumber, tenancyId: data.tenancyId, unitId: data.unitId,
      partyId: data.partyId, chargeType, status: "draft",
      description: chargeType === "letting_commission" ? "First-month letting commission" : "Monthly rent",
      dueDate: data.dueDate,
      amount: data.amount, currency: "MYR", outstandingAmount: data.amount, billingMonth: data.billingMonth,
      attachmentKeys: [], invoiceId: data.invoiceId,
    },
    select: { id: true, amount: true },
  });
}

export async function attachChargeTx(tx: Prisma.TransactionClient, orgId: string, chargeId: string, invoiceId: string) {
  await tx.charge.update({ where: { id: chargeId, organizationId: orgId }, data: { invoiceId } });
}
export async function detachChargeTx(tx: Prisma.TransactionClient, orgId: string, chargeId: string) {
  await tx.charge.update({ where: { id: chargeId, organizationId: orgId }, data: { invoiceId: null } });
}

// Sum un-voided linked charges; write back to Invoice.totalAmount. Deterministic 2dp.
export async function recomputeInvoiceTotalTx(tx: Prisma.TransactionClient, orgId: string, invoiceId: string) {
  const charges = await tx.charge.findMany({ where: { organizationId: orgId, invoiceId, status: { not: "void" } }, select: { amount: true } });
  const cents = charges.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0);
  await tx.invoice.update({ where: { id: invoiceId, organizationId: orgId }, data: { totalAmount: (cents / 100).toFixed(2) } });
  return cents / 100;
}

// Owners eligible for a statement = distinct owners of ≥1 non-archived Listing
// (keyed per-unit by Listing.ownerPartyId; owner money is attributed per-unit, NOT
// per-property via LandlordTenancy). generateStatementService internally no-ops
// owners with no fee config / no lines.
export async function listDistinctActiveOwners(orgId: string): Promise<string[]> {
  const rows = await getDb().listing.findMany({
    where: { organizationId: orgId, ownerPartyId: { not: null }, listingStatus: { not: "archived" } },
    select: { ownerPartyId: true }, distinct: ["ownerPartyId"],
  });
  return rows.flatMap((r) => (r.ownerPartyId ? [r.ownerPartyId] : []));
}

// ── Query readers (Task 6) ──────────────────────────────────────────────────

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

export async function listDraftRuns(
  orgId: string,
  q: { periodMonth?: string; status?: string; limit: number; offset: number },
) {
  const where: Prisma.InvoiceDraftRunWhereInput = {
    organizationId: orgId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.periodMonth ? { periodMonth: firstOfMonthUtc(q.periodMonth) } : {}),
  };
  const db = getDb();
  const [rows, total] = await Promise.all([
    db.invoiceDraftRun.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: q.offset,
      take: q.limit,
    }),
    db.invoiceDraftRun.count({ where }),
  ]);
  return { rows, total };
}

export async function getDraftRun(orgId: string, id: string) {
  return getDb().invoiceDraftRun.findFirst({ where: { id, organizationId: orgId } });
}

/**
 * The distinct billing months this org has a COMPLETED draft run for, at or
 * after `sinceYm`, as "YYYY-MM". Feeds findMissingBillingPeriods.
 *
 * "completed" is the coverage test, deliberately:
 *   • a `failed` or still-`running` row means the month was NOT drafted, so it
 *     must stay reportable as a gap;
 *   • a completed row that drafted nothing because the org had no active
 *     DraftConfig still counts as covered — billing was deliberately off that
 *     month, and reporting it would bury a real gap in noise from paused orgs.
 *
 * The month a `billPeriodOffset` change skips has NO run row of any status, so
 * the case this was written for is caught either way.
 */
export async function listCompletedDraftPeriodsSince(orgId: string, sinceYm: string): Promise<string[]> {
  const rows = await getDb().invoiceDraftRun.findMany({
    where: {
      organizationId: orgId,
      status: "completed",
      periodMonth: { gte: firstOfMonthUtc(sinceYm) },
    },
    select: { periodMonth: true },
    distinct: ["periodMonth"],
  });
  // periodMonth is stored as a UTC first-of-month, so a UTC read is the inverse
  // of firstOfMonthUtc. A local-time read would shift east-of-UTC hosts a month.
  return rows.map((r) => ymOfUtc(r.periodMonth));
}

export async function listDraftInvoices(
  orgId: string,
  q: { status?: string; periodMonth?: string; partyId?: string; invoiceType?: string; limit: number; offset: number },
) {
  const where: Prisma.InvoiceWhereInput = {
    organizationId: orgId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.periodMonth ? { periodMonth: firstOfMonthUtc(q.periodMonth) } : {}),
    ...(q.partyId ? { partyId: q.partyId } : {}),
    ...(q.invoiceType ? { invoiceType: q.invoiceType } : {}),
  };
  const db = getDb();
  const [rows, total] = await Promise.all([
    db.invoice.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: q.offset,
      take: q.limit,
      include: {
        party: { select: { displayName: true } },
        tenancy: { select: { tenancyCode: true, unitId: true } },
      },
    }),
    db.invoice.count({ where }),
  ]);

  // WHICH unit each row bills. Resolved in ONE batched query keyed on the distinct
  // unitIds — never per row: this queue loads up to 200 invoices in a single shot
  // (invoiceQueueQuerySchema caps at 200), so a per-row lookup would be a 200-query
  // N+1 on the page an admin opens most.
  const unitIds = [...new Set(rows.map((r) => r.tenancy?.unitId).filter((v): v is string => !!v))];
  const unitById = new Map<string, { unitCode: string | null; propertyName: string | null }>();
  if (unitIds.length > 0) {
    const listings = await db.listing.findMany({
      where: { id: { in: unitIds }, organizationId: orgId },
      select: {
        id: true,
        apartment: { select: { unitCode: true, property: { select: { name: true } } } },
      },
    });
    for (const l of listings) {
      unitById.set(l.id, {
        unitCode: l.apartment?.unitCode ?? null,
        propertyName: l.apartment?.property?.name ?? null,
      });
    }
  }

  const withUnit = rows.map((r) => {
    const u = r.tenancy?.unitId ? unitById.get(r.tenancy.unitId) : undefined;
    return { ...r, unitCode: u?.unitCode ?? null, propertyName: u?.propertyName ?? null };
  });
  return { rows: withUnit, total };
}

/**
 * WHICH property / WHICH unit a draft is for. An admin approving money needs this and
 * the drawer had no way to show it: Invoice.propertyId and Tenancy.unitId are RAW uuid
 * columns with no Prisma relation, so neither can be reached from an `include`.
 *
 * Resolved via the one relation chain that does exist:
 *   Tenancy.unitId → Listing (@@map "Unit") → Apartment.unitCode → Property.name
 *
 * Returns nulls rather than throwing — an owner-side draft has no tenancy, and a
 * missing unit must degrade to "—" in the UI, never blank the whole drawer.
 */
async function resolveUnitContext(orgId: string, unitId: string | null) {
  if (!unitId) return { unitCode: null, propertyName: null, listingType: null };
  const listing = await getDb().listing.findFirst({
    where: { id: unitId, organizationId: orgId },
    select: {
      listingType: true,
      apartment: { select: { unitCode: true, property: { select: { name: true } } } },
    },
  });
  return {
    unitCode: listing?.apartment?.unitCode ?? null,
    propertyName: listing?.apartment?.property?.name ?? null,
    listingType: listing?.listingType ?? null,
  };
}

export async function getDraftInvoiceWithCharges(orgId: string, id: string) {
  const invoice = await getDb().invoice.findFirst({
    where: { id, organizationId: orgId },
    include: {
      party: { select: { displayName: true } },
      // unitId rides along so the property/unit lookup below has its key.
      tenancy: { select: { tenancyCode: true, unitId: true } },
      charges: {
        where: { status: { not: "void" } },
        // billingMonth: a draft can hold charges from more than one month once an
        // admin attaches one, so each LINE states its own period rather than letting
        // the invoice header imply it.
        select: {
          id: true, chargeNumber: true, chargeType: true, status: true,
          amount: true, description: true, billingMonth: true,
        },
      },
    },
  });
  if (!invoice) return null;
  const unit = await resolveUnitContext(orgId, invoice.tenancy?.unitId ?? null);
  return { ...invoice, ...unit };
}

export { toNumber };
