import type { FirstMonthPreview, CommissionPreview } from "@kason/shared";
import { computeProratedRent } from "../billing/post-monthly-rent";
import { resolveCommissionMonth } from "../../lib/commission-month";

/**
 * Read-only preview of the first rent charge. Delegates the arithmetic to
 * computeProratedRent so the UI can never disagree with what the poster
 * writes. This module MUST NOT re-implement the formula.
 *
 * IMPORTANT — poster-faithfulness over `rentInvoiceStartDate`:
 * The poster (resolveMonthlyRentAmount -> computeProratedRent, post-monthly-rent.ts)
 * prorates from `tenancy.startDate` and NEVER reads `rentInvoiceStartDate`
 * (grep: zero consumers in apps/api/src/modules/billing). If this preview shifted
 * the month/amount by `rentInvoiceStartDate`, it would promise a month the
 * auto-draft cron will not bill (e.g. "no July invoice, full August" while the
 * cron still drafts a prorated July) — a money-communication divergence.
 *
 * So `rentInvoiceStartDate` is accepted (for forward-compat with the persisted
 * "Start Rental Invoice on" column) but DELIBERATELY IGNORED here: the preview
 * always describes the prorated move-in month, exactly what the cron posts.
 * Re-introducing the invoice-start shift REQUIRES first teaching the poster to
 * honour `rentInvoiceStartDate` — change both sides together, never this one alone.
 */
export function previewFirstMonthRent(input: {
  monthlyRent: number;
  startDate: Date;
  endDate: Date | null;
  rentInvoiceStartDate?: Date | null;
}): FirstMonthPreview {
  // Anchor and occupancy window both derive from the move-in date — mirroring the
  // poster. rentInvoiceStartDate is intentionally not consulted (see docstring).
  const y = input.startDate.getUTCFullYear();
  const m = input.startDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const month = `${y}-${String(m + 1).padStart(2, "0")}`;

  const amount = computeProratedRent(input.monthlyRent, input.startDate, input.endDate, input.startDate);

  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m, daysInMonth));
  const ws = input.startDate > monthStart ? input.startDate : monthStart;
  const we = input.endDate && input.endDate < monthEnd ? input.endDate : monthEnd;
  const day = (d: Date) =>
    Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
  const occupiedDays = Math.max(0, day(we) - day(ws) + 1);

  return { month, amount, occupiedDays, daysInMonth, isProrated: occupiedDays < daysInMonth };
}

/**
 * The first-month commission KAEN keeps when a tenancy is a commission tenancy.
 * Phase 1: display-only, moves no money. The amount is the FULL month's rent
 * (never prorated) and SST is a flat 8% of that rental — NOT the per-owner
 * ManagementFeeConfig.sstPercent, which governs the management fee on a
 * different base. Returns null when the tenancy is not a commission tenancy or
 * contains no full calendar month.
 */
export function computeFirstMonthCommission(input: {
  monthlyRent: number;
  startDate: Date;
  endDate: Date | null;
  isCommission: boolean;
  sstBearer: "owner" | "kaen";
}): CommissionPreview | null {
  if (!input.isCommission) return null;
  if (!Number.isFinite(input.monthlyRent) || input.monthlyRent <= 0) return null;

  // Single source of truth for WHICH month is the commission month (the first FULL
  // calendar month; prorated move-in month excluded; NaN-date-safe). SHARED with the
  // billing poster (monthlyChargeType → resolveCommissionMonth), so this preview can never
  // promise a commission month the poster won't actually bill.
  const cm = resolveCommissionMonth(input.startDate, input.endDate);
  if (!cm) return null;

  const month = `${cm.year}-${String(cm.month0 + 1).padStart(2, "0")}`;
  const commissionAmount = Math.round(input.monthlyRent * 100) / 100;
  const sstRate = 0.08;
  const sstAmount = Math.round(input.monthlyRent * sstRate * 100) / 100;
  const total = Math.round((commissionAmount + sstAmount) * 100) / 100;

  return { month, commissionAmount, sstRate, sstAmount, sstBearer: input.sstBearer, total };
}
