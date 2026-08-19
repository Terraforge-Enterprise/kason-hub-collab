import { getDb } from "@kason/db";
import type { DashboardSession } from "./dashboard.types";
import { getCounts, getOrgName, getPostedCharges } from "./dashboard.repository";
import { dashboardCache } from "../../lib/cache";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getDashboardSummaryService(session: DashboardSession) {
  const cacheKey = `dashboard:summary:${session.orgId}`;
  const cached = dashboardCache.get<Awaited<ReturnType<typeof _getDashboardSummary>>>(cacheKey);
  if (cached) return cached;

  const result = await _getDashboardSummary(session);
  dashboardCache.set(cacheKey, result, CACHE_TTL);
  return result;
}

async function _getDashboardSummary(session: DashboardSession) {
  const [orgName, counts, postedCharges] = await Promise.all([
    getOrgName(session.orgId),
    getCounts(session.orgId),
    getPostedCharges(session.orgId),
  ]);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const totalOutstanding = postedCharges.reduce(
    (sum, c) => sum + Number(c.outstandingAmount.toString()),
    0,
  );

  const totalPaidAmt = postedCharges
    .filter((c) => Number(c.outstandingAmount.toString()) === 0)
    .reduce((sum, c) => sum + Number(c.amount.toString()), 0);

  const totalUnpaidAmt = postedCharges
    .filter((c) => Number(c.outstandingAmount.toString()) > 0)
    .reduce((sum, c) => sum + Number(c.outstandingAmount.toString()), 0);

  const comingDueAmt = postedCharges
    .filter((c) => Number(c.outstandingAmount.toString()) > 0 && new Date(c.dueDate) >= today)
    .reduce((sum, c) => sum + Number(c.outstandingAmount.toString()), 0);

  const overdueAmt = postedCharges
    .filter((c) => Number(c.outstandingAmount.toString()) > 0 && new Date(c.dueDate) < today)
    .reduce((sum, c) => sum + Number(c.outstandingAmount.toString()), 0);

  const occupancyRate = counts.unitCount > 0 ? Math.round((counts.occupiedUnitCount / counts.unitCount) * 100) : 0;

  return {
    orgName,
    metrics: {
      ...counts,
      occupancyRate,
      vacancyRate: counts.unitCount > 0 ? Math.round((counts.vacantUnitCount / counts.unitCount) * 100) : 0,
      draftChargeCount: Math.max(counts.chargeCount - counts.postedChargeCount, 0),
    },
    finance: {
      totalOutstanding,
      totalPaidAmt,
      totalUnpaidAmt,
      comingDueAmt,
      overdueAmt,
    },
  };
}

export async function getDashboardStatsService(session: DashboardSession) {
  const cacheKey = `dashboard:stats:${session.orgId}`;
  const cached = dashboardCache.get<Awaited<ReturnType<typeof _getDashboardStats>>>(cacheKey);
  if (cached) return cached;

  const result = await _getDashboardStats(session);
  dashboardCache.set(cacheKey, result, CACHE_TTL);
  return result;
}

async function _getDashboardStats(session: DashboardSession) {
  const db = getDb();
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    summary,
    expiringTenancyCount,
    pendingChargeCount,
    pendingChargeTotal,
    thisMonthPaymentTotal,
    recentTenancies,
    recentOverdueCharges,
    recentPayments,
    recentNotifications,
  ] = await Promise.all([
    getDashboardSummaryService(session),
    db.tenancy.count({
      where: {
        organizationId: session.orgId,
        status: "active",
        endDate: { lte: thirtyDaysFromNow, gte: now },
      },
    }),
    db.charge.count({
      where: { organizationId: session.orgId, status: "draft" },
    }),
    db.charge.aggregate({
      where: { organizationId: session.orgId, status: "draft" },
      _sum: { amount: true },
    }),
    db.payment.aggregate({
      where: {
        organizationId: session.orgId,
        createdAt: { gte: startOfMonth },
      },
      _sum: { amount: true },
    }),
    db.tenancy.findMany({
      where: { organizationId: session.orgId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        tenancyCode: true,
        status: true,
        startDate: true,
        endDate: true,
        createdAt: true,
        property: { select: { id: true, name: true } },
        unit: { select: { id: true, apartment: { select: { unitCode: true } } } },
      },
    }),
    db.charge.findMany({
      where: {
        organizationId: session.orgId,
        status: "posted",
        dueDate: { lt: now },
        outstandingAmount: { gt: 0 },
      },
      orderBy: { dueDate: "asc" },
      take: 5,
      select: {
        id: true,
        chargeNumber: true,
        chargeType: true,
        amount: true,
        outstandingAmount: true,
        dueDate: true,
        status: true,
      },
    }),
    db.payment.findMany({
      where: { organizationId: session.orgId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        amount: true,
        receivedAt: true,
        paymentMethod: true,
        createdAt: true,
      },
    }),
    db.notification.findMany({
      where: { organizationId: session.orgId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        domain: true,
        title: true,
        body: true,
        read: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    ...summary,
    counts: {
      ...summary.metrics,
      expiringTenancies: expiringTenancyCount,
      pendingCharges: pendingChargeCount,
      pendingChargeAmount: Number(pendingChargeTotal._sum.amount?.toString() ?? "0"),
      thisMonthPayments: Number(thisMonthPaymentTotal._sum.amount?.toString() ?? "0"),
    },
    recent: {
      tenancies: recentTenancies.map((t) => ({
        id: t.id,
        tenancyCode: t.tenancyCode,
        status: t.status,
        startDate: t.startDate,
        endDate: t.endDate,
        createdAt: t.createdAt,
        property: t.property,
        unit: { id: t.unit.id, unitCode: t.unit.apartment.unitCode },
      })),
      overdueCharges: recentOverdueCharges,
      payments: recentPayments,
      notifications: recentNotifications,
    },
  };
}
