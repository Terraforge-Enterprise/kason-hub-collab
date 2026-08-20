import {
  computeAccessCardDepositMyr,
  computeRentalDepositMyr,
  computeUtilitiesDepositMyr,
  resolveDepositBasisRate,
  DEFAULT_ACCESS_CARD_DEPOSIT_PER_PCS,
  DEFAULT_RENTAL_DEPOSIT_MONTHS,
  DEFAULT_UTILITIES_DEPOSIT_MONTHS,
} from "@kason/shared";
import { Input } from "@/components/ui/input";

type DepositFieldsValue = {
  depositMonths: number | null;
  utilitiesDepositMonths: number | null;
  accessCardDepositPerPcs: number | null;
  accessCardQuantity: number | null;
};

type DepositFieldsChange = Partial<DepositFieldsValue>;

interface DepositFieldsProps extends DepositFieldsValue {
  rentalRate: number | null;
  /**
   * The ACTIVE tenancy's negotiated monthly rent, when this unit is occupied.
   *
   * OPTIONAL and defaulting to undefined so every caller that has no tenancy in hand
   * (create-unit, the multi-room create dialog, the partition strip, the portal edit
   * page) keeps its exact previous behaviour: basis = rentalRate. Only the occupied
   * edit-unit form supplies it, and only there does the displayed RM change.
   */
  tenancyMonthlyRent?: number | null;
  onChange: (patch: DepositFieldsChange) => void;
}

function formatMyr(amount: number | null): string {
  if (amount === null) return "";
  return `RM${amount.toLocaleString("en-MY", { maximumFractionDigits: 2 })}`;
}

function parseNumberOrNull(raw: string): number | null {
  // Deposits, utilities, access-card prices and counts can never be negative.
  // Strip minus signs before parsing so a user typing "-1" lands at 1 (not -1
  // stored as "RM-1,300" in the sidecar). Empty stays null; non-numeric → null.
  const cleaned = raw.replace(/-/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function DepositFields(props: DepositFieldsProps) {
  const {
    rentalRate,
    tenancyMonthlyRent,
    depositMonths,
    utilitiesDepositMonths,
    accessCardDepositPerPcs,
    accessCardQuantity,
    onChange,
  } = props;

  // Deposits are a multiple of the rent that ACTUALLY applies to this unit — the
  // tenancy's when occupied, the asking rate otherwise. Both deposit rows read the
  // same basis, so they can never disagree with each other.
  const basisRate = resolveDepositBasisRate({ tenancyMonthlyRent, rentalRate });
  const basisIsTenancyRent = tenancyMonthlyRent != null;

  const rentalDepositMyr = computeRentalDepositMyr({ rentalRate: basisRate, depositMonths });
  const utilitiesDepositMyr = computeUtilitiesDepositMyr({
    rentalRate: basisRate,
    utilitiesDepositMonths,
  });
  const accessCardDepositMyr = computeAccessCardDepositMyr({
    accessCardDepositPerPcs,
    accessCardQuantity,
  });

  return (
    <fieldset className="space-y-4 rounded-md border border-border p-4">
      <legend className="px-2 text-sm font-medium">Deposits</legend>

      {/* Name the basis explicitly. Without it, an occupied unit shows a deposit derived
          from a rent that appears NOWHERE else on the screen, and the admin has no way to
          tell whether they are looking at the asking rate or the tenant's real rent. */}
      {basisRate !== null && (
        <p className="text-xs text-muted-foreground">
          Based on {basisIsTenancyRent ? "this tenancy's rent" : "the asking rate"} of{" "}
          {formatMyr(basisRate)}/month.
        </p>
      )}

      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <label className="block">
          <span className="text-xs text-muted-foreground">
            Rental deposit (months) <span className="text-rose-400">*</span>
          </span>
          <Input
            type="number"
            min={0}
            max={12}
            step={0.5}
            required
            aria-required="true"
            value={depositMonths ?? ""}
            placeholder={`e.g. ${DEFAULT_RENTAL_DEPOSIT_MONTHS}`}
            onChange={(e) => onChange({ depositMonths: parseNumberOrNull(e.target.value) })}
          />
        </label>
        <span className="text-sm text-muted-foreground pb-2">
          {formatMyr(rentalDepositMyr)}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <label className="block">
          <span className="text-xs text-muted-foreground">
            Utilities deposit (months) <span className="text-rose-400">*</span>
          </span>
          <Input
            type="number"
            min={0}
            max={12}
            step={0.5}
            required
            aria-required="true"
            value={utilitiesDepositMonths ?? ""}
            placeholder={`e.g. ${DEFAULT_UTILITIES_DEPOSIT_MONTHS}`}
            onChange={(e) =>
              onChange({ utilitiesDepositMonths: parseNumberOrNull(e.target.value) })
            }
          />
        </label>
        <span className="text-sm text-muted-foreground pb-2">
          {formatMyr(utilitiesDepositMyr)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 items-end">
        <label className="block">
          <span className="text-xs text-muted-foreground">Access card quantity</span>
          <Input
            type="number"
            min={0}
            max={20}
            value={accessCardQuantity ?? ""}
            onChange={(e) =>
              onChange({ accessCardQuantity: parseNumberOrNull(e.target.value) })
            }
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">RM / piece</span>
          <Input
            type="number"
            min={0}
            value={accessCardDepositPerPcs ?? ""}
            placeholder={String(DEFAULT_ACCESS_CARD_DEPOSIT_PER_PCS)}
            onChange={(e) =>
              onChange({ accessCardDepositPerPcs: parseNumberOrNull(e.target.value) })
            }
          />
        </label>
        <span className="text-sm text-muted-foreground pb-2">
          {formatMyr(accessCardDepositMyr)}
        </span>
      </div>
    </fieldset>
  );
}
