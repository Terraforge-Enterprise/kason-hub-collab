import type { GridRow } from "@/api/bills-grid";
import { cleaningSeed } from "./cell-seed";
import { isApplicable } from "./cell-applicability";
import { scalarGeneratedAmount } from "./row-lock";

function money(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Projected amount payable to the owner for this unit and billing month.
 * This intentionally uses the same visible billing-grid sources, so tenant-
 * borne charges never reduce the owner's payout and owner-borne charges do.
 */
export function projectedOwnerPayout(row: GridRow): number {
  if (row.ownerPayout != null) return Math.max(0, money(row.ownerPayout));
  const income = row.subRows.reduce(
    (sum, subRow) => sum + money(subRow.rental) + money(subRow.deposit),
    0,
  );

  const applicableScalar = (columnId: "cleaningOwner" | "tnbOwner" | "airOwner" | "wifiOwner" | "maintenanceFee") => {
    if (!isApplicable(row, columnId)) return 0;
    if (columnId === "cleaningOwner") return money(scalarGeneratedAmount(row, columnId) || cleaningSeed(row));
    if (columnId === "wifiOwner" || columnId === "maintenanceFee") {
      return money(scalarGeneratedAmount(row, columnId) || (columnId === "wifiOwner" ? row.entry?.wifi : row.entry?.maintenanceFee));
    }
    return money(columnId === "tnbOwner" ? row.entry?.tnbTotal : row.entry?.airSelangor);
  };

  const deductions =
    applicableScalar("cleaningOwner") +
    applicableScalar("tnbOwner") +
    applicableScalar("airOwner") +
    applicableScalar("wifiOwner") +
    applicableScalar("maintenanceFee") +
    money(row.recurring?.owner.total) +
    money(row.expenses.owner.total) +
    money(row.managementFee?.nonSst) +
    money(row.managementFee?.sst);

  return Math.max(0, income - deductions);
}
