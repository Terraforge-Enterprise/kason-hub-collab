import { expect, it } from "vitest";
import { canSeeNavItemFor, type NavItem } from "../navigation";
import { FileText, Building2, LayoutDashboard } from "lucide-react";

const accounting: NavItem = { title: "Documents", href: "/billing/documents", icon: FileText, minRole: "manager", workspace: "accounting" };
const neutral: NavItem = { title: "Overview", href: "/dashboard", icon: LayoutDashboard, workspace: "neutral" };
const operational: NavItem = { title: "Inventory", href: "/inventory", icon: Building2 };

it("accountant sees accounting + neutral, not untagged operational", () => {
  expect(canSeeNavItemFor("accountant", accounting)).toBe(true);
  expect(canSeeNavItemFor("accountant", neutral)).toBe(true);
  expect(canSeeNavItemFor("accountant", operational)).toBe(false);
});

it("admin sees operational and accounting items", () => {
  expect(canSeeNavItemFor("admin", operational)).toBe(true);
  expect(canSeeNavItemFor("admin", accounting)).toBe(true);
});

it("editor does not see accounting-only items", () => {
  expect(canSeeNavItemFor("editor", accounting)).toBe(false);
  expect(canSeeNavItemFor("editor", operational)).toBe(true);
});
