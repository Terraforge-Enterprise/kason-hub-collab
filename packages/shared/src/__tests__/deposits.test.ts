import { describe, expect, it } from "vitest";
import {
  computeRentalDepositMyr,
  computeUtilitiesDepositMyr,
  computeAccessCardDepositMyr,
  resolveDepositBasisRate,
} from "../deposits";

describe("computeRentalDepositMyr", () => {
  it("returns rentalRate × depositMonths", () => {
    expect(computeRentalDepositMyr({ rentalRate: 1000, depositMonths: 2 })).toBe(2000);
  });

  it("returns null when rentalRate is missing", () => {
    expect(computeRentalDepositMyr({ rentalRate: null, depositMonths: 2 })).toBeNull();
  });

  it("treats missing depositMonths as default 2", () => {
    expect(computeRentalDepositMyr({ rentalRate: 1500, depositMonths: null })).toBe(3000);
  });
});

describe("computeUtilitiesDepositMyr", () => {
  it("returns rentalRate × utilitiesDepositMonths (default 0.5)", () => {
    expect(computeUtilitiesDepositMyr({ rentalRate: 1000, utilitiesDepositMonths: null })).toBe(500);
  });

  it("honours uploader override on utilitiesDepositMonths", () => {
    expect(computeUtilitiesDepositMyr({ rentalRate: 1000, utilitiesDepositMonths: 1 })).toBe(1000);
  });

  it("returns null when rentalRate is missing", () => {
    expect(computeUtilitiesDepositMyr({ rentalRate: null, utilitiesDepositMonths: 0.5 })).toBeNull();
  });
});

describe("computeAccessCardDepositMyr", () => {
  it("returns accessCardDepositPerPcs × accessCardQuantity (default 100/pc)", () => {
    expect(computeAccessCardDepositMyr({ accessCardDepositPerPcs: null, accessCardQuantity: 2 })).toBe(200);
  });

  it("honours per-pc override", () => {
    expect(computeAccessCardDepositMyr({ accessCardDepositPerPcs: 150, accessCardQuantity: 2 })).toBe(300);
  });

  it("returns null when quantity is missing or zero", () => {
    expect(computeAccessCardDepositMyr({ accessCardDepositPerPcs: 100, accessCardQuantity: null })).toBeNull();
    expect(computeAccessCardDepositMyr({ accessCardDepositPerPcs: 100, accessCardQuantity: 0 })).toBe(0);
  });
});

describe("resolveDepositBasisRate", () => {
  it("prefers the TENANCY's rent over the listing's asking rate", () => {
    // The reported bug: a unit advertised at RM1,500 let at RM5 showed a RM3,000 rental
    // deposit beside a first-invoice card priced off the real RM5 — same screen, two rents.
    expect(resolveDepositBasisRate({ tenancyMonthlyRent: 5, rentalRate: 1500 })).toBe(5);
  });

  it("carries through to the amounts an occupied unit displays", () => {
    const basis = resolveDepositBasisRate({ tenancyMonthlyRent: 5, rentalRate: 1500 });
    expect(computeRentalDepositMyr({ rentalRate: basis, depositMonths: 2 })).toBe(10);
    expect(computeUtilitiesDepositMyr({ rentalRate: basis, utilitiesDepositMonths: 0.5 })).toBe(2.5);
  });

  it("falls back to the asking rate when there is no tenancy (vacant / create)", () => {
    expect(resolveDepositBasisRate({ tenancyMonthlyRent: null, rentalRate: 1500 })).toBe(1500);
    expect(resolveDepositBasisRate({ tenancyMonthlyRent: undefined, rentalRate: 1500 })).toBe(1500);
  });

  it("treats a ZERO tenancy rent as a real figure, never a missing one", () => {
    // A truthiness test here would silently price a rent-free tenant's deposit off the
    // asking rate — the exact class of bug this helper exists to remove.
    expect(resolveDepositBasisRate({ tenancyMonthlyRent: 0, rentalRate: 1500 })).toBe(0);
  });

  it("propagates null when neither rent is known", () => {
    expect(resolveDepositBasisRate({ tenancyMonthlyRent: null, rentalRate: null })).toBeNull();
  });
});
