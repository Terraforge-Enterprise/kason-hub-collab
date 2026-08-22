import { describe, expect, it } from "vitest";
import { hasPermission } from "../permissions";

describe("Tenant Management business permissions", () => {
  it("lets Operations Admin read and categorise bank transactions", () => {
    expect(hasPermission("editor", "bank.read")).toBe(true);
    expect(hasPermission("editor", "bank.categorize")).toBe(true);
  });

  it("keeps cost creation and profit away from Operations Admin", () => {
    expect(hasPermission("editor", "cost.create_from_bank")).toBe(false);
    expect(hasPermission("editor", "profit.view")).toBe(false);
    expect(hasPermission("editor", "bank.import")).toBe(false);
  });

  it("gives Finance the accounting capabilities without final owner-report approval", () => {
    expect(hasPermission("accountant", "bank.import")).toBe(true);
    expect(hasPermission("accountant", "cost.create_from_bank")).toBe(true);
    expect(hasPermission("accountant", "profit.view")).toBe(true);
    expect(hasPermission("accountant", "owner_report.final_approve")).toBe(false);
  });

  it("separates first check from final approval", () => {
    expect(hasPermission("manager", "owner_report.first_check")).toBe(true);
    expect(hasPermission("manager", "owner_report.final_approve")).toBe(false);
    expect(hasPermission("director", "owner_report.final_approve")).toBe(true);
    expect(hasPermission("admin", "owner_report.final_approve")).toBe(true);
  });

  it("gives Manager every department permission except final owner-report approval", () => {
    expect(hasPermission("manager", "portfolio.delete")).toBe(true);
    expect(hasPermission("manager", "profit.view")).toBe(true);
    expect(hasPermission("manager", "bank.import")).toBe(false);
    expect(hasPermission("manager", "bank.manage_accounts")).toBe(false);
    expect(hasPermission("manager", "bank.export")).toBe(false);
    expect(hasPermission("manager", "roles.manage")).toBe(true);
    expect(hasPermission("manager", "owner_report.final_approve")).toBe(false);
    expect(hasPermission("manager", "tenancy.cancel_renewal")).toBe(true);
    expect(hasPermission("director", "tenancy.cancel_renewal")).toBe(true);
    expect(hasPermission("admin", "tenancy.cancel_renewal")).toBe(true);
    expect(hasPermission("editor", "tenancy.cancel_renewal")).toBe(false);
  });

  it("locks bank import, bank-account management and reconciliation export to Finance and Super Admin", () => {
    for (const permission of ["bank.import", "bank.manage_accounts", "bank.export"] as const) {
      expect(hasPermission("accountant", permission)).toBe(true);
      expect(hasPermission("admin", permission)).toBe(true);
      expect(hasPermission("director", permission)).toBe(false);
      expect(hasPermission("manager", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("editor", permission, { [permission]: true })).toBe(false);
    }
  });

  it("locks claim approval and reimbursement to Super Admin, Finance and Director", () => {
    for (const permission of ["claim.approve", "claim.reimburse"] as const) {
      expect(hasPermission("admin", permission)).toBe(true);
      expect(hasPermission("accountant", permission)).toBe(true);
      expect(hasPermission("director", permission)).toBe(true);
      expect(hasPermission("manager", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("editor", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("viewer", permission, { [permission]: true })).toBe(false);
    }
  });

  it("locks settings management and important-record deletion to Super Admin", () => {
    for (const permission of ["settings.manage", "important_record.delete"] as const) {
      expect(hasPermission("admin", permission)).toBe(true);
      expect(hasPermission("director", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("accountant", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("manager", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("editor", permission, { [permission]: true })).toBe(false);
      expect(hasPermission("viewer", permission, { [permission]: true })).toBe(false);
    }
  });

  it("allows a Super Admin to grant Margin access to one Operations Admin", () => {
    expect(hasPermission("editor", "profit.view", { "profit.view": true })).toBe(true);
    expect(hasPermission("editor", "bank.import", { "profit.view": true })).toBe(false);
  });

  it("allows an individual deny to override a role default", () => {
    expect(hasPermission("manager", "owner_report.first_check", { "owner_report.first_check": false })).toBe(false);
  });

  it("never removes Super Admin control through an override", () => {
    expect(hasPermission("admin", "roles.manage", { "roles.manage": false })).toBe(true);
  });
});
