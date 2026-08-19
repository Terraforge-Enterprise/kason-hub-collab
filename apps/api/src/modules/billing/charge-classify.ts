// Pure classification helpers for the charges v2 register (2026-07-04 spec).
// PRESENTATION ONLY: nothing here writes or alters charge.status.

import { OWNER_CHARGE_TYPES } from "@kason/shared";

/**
 * Derived display status (spec D6). Owner-statement child charges live their
 * whole life as status "draft" (they settle by payout netting, never by
 * posting) — the register shows them as "on_statement" instead of the
 * misleading eternal "draft". Every other status passes through, including
 * "void"/"credited" on statement children.
 */
export function chargeDisplayStatus(charge: {
  status: string;
  invoice: { invoiceType: string } | null;
}): string {
  if (charge.status === "draft" && charge.invoice?.invoiceType === "owner_statement") {
    return "on_statement";
  }
  return charge.status;
}

/**
 * chargeType fallback for OWNER-billed rows whose categoryId is still null
 * (pre-backfill legacy). Derived from the authoritative OWNER_CHARGE_TYPES
 * enum (packages/shared/src/schemas/owner-billing.ts) — the validated write-
 * set of owner statement lines — so it can never drift from the generators.
 * Post-backfill, category.family is authoritative and this is a safety net.
 */
export const OWNER_FALLBACK_CHARGE_TYPES = OWNER_CHARGE_TYPES;

/** Prisma where-fragment selecting OWNER-billed charges (counterparty=owner). */
export function ownerCounterpartyWhere() {
  return {
    OR: [
      { category: { family: "owner_income" } },
      { categoryId: null, chargeType: { in: [...OWNER_FALLBACK_CHARGE_TYPES] } },
    ],
  };
}

export type ChargeTrack = "tenant_fees" | "pass_through" | "owner";

/** Settlement track (spec R1). invoiceType owner_statement wins, then family,
 *  then the null-category chargeType fallback (mirrors isOwnerBilled). */
export function chargeTrack(charge: {
  categoryId?: string | null;
  category: { family: string } | null;
  chargeType: string;
  invoice: { invoiceType: string } | null;
}): ChargeTrack {
  if (charge.invoice?.invoiceType === "owner_statement") return "owner";
  if (charge.category) {
    if (charge.category.family === "owner_income") return "owner";
    if (charge.category.family === "tenant_income") return "tenant_fees";
    return "pass_through"; // pay_back_landlord
  }
  return (OWNER_FALLBACK_CHARGE_TYPES as readonly string[]).includes(charge.chargeType)
    ? "owner"
    : "pass_through";
}

/** chargeType → friendly label (spec R4). Keyed on chargeType (populated when
 *  categoryId is null) — a DIFFERENT vocabulary from ChargeCategory.code. */
const CHARGE_TYPE_LABELS: Record<string, string> = {
  management_fee: "Management fee", cleaning: "Cleaning", tnb: "TNB electricity",
  water: "Water", wifi: "WiFi", sewerage: "Sewerage", maintenance: "Maintenance",
  insurance: "Insurance", assessment_tax: "Assessment tax", cukai_petak: "Cukai petak",
  access_card: "Access card", other: "Other",
  rent: "Monthly rental", rental: "Monthly rental", aircond: "Aircond (submeter)",
  carpark: "Carpark", utility: "Utilities — TNB electricity",
};

function humanizeChargeType(slug: string): string {
  const s = slug.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Display label: category.name → chargeType map → humanize. Never null (R4). */
export function chargeCategoryLabel(charge: {
  category: { name: string } | null;
  chargeType: string;
}): string {
  return charge.category?.name ?? CHARGE_TYPE_LABELS[charge.chargeType] ?? humanizeChargeType(charge.chargeType);
}
