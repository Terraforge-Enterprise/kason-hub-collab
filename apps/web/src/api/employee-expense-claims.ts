import { apiFetch } from "@/lib/api-client";

export type EmployeeExpenseClaim = {
  id: string; expenseNumber: string; supplierName: string; expenseDate: string; totalAmount: string;
  description: string | null; claimantName: string | null; costPurpose: "unit_specific" | "shared_materials" | "company_overhead";
  approvalStatus: "submitted" | "approved" | "rejected"; reimbursementStatus: string;
  apartmentId: string | null; allocatedCost: string; unallocatedCost: string; reimbursedAmount: string;
  costAssignments: Array<{ id: string; apartmentId: string; amount: string; description: string | null }>;
};

export async function listEmployeeExpenseClaims() {
  const rows = (await apiFetch<{ data: EmployeeExpenseClaim[] }>("/expenses")).data;
  return rows.filter((row) => row.claimantName != null);
}

export async function createEmployeeExpenseClaim(input: { claimantName: string; supplierName: string; expenseDate: string; totalAmount: string; description: string; costPurpose: EmployeeExpenseClaim["costPurpose"]; apartmentId?: string | null }) {
  return (await apiFetch<{ data: { id: string; expenseNumber: string } }>("/expenses", { method: "POST", body: JSON.stringify({ ...input, paymentSource: "employee_advance", allocations: [{ borneBy: "kaen", amount: input.totalAmount, description: input.description }] }) })).data;
}

export async function approveEmployeeExpenseClaim(id: string) {
  return (await apiFetch<{ data: EmployeeExpenseClaim }>(`/expenses/${id}/approve`, { method: "POST" })).data;
}

export async function assignEmployeeClaimCost(id: string, input: { apartmentId: string; gridExpenseId?: string | null; amount: string; description?: string }) {
  return (await apiFetch<{ data: unknown }>(`/expenses/${id}/assignments`, { method: "POST", body: JSON.stringify(input) })).data;
}
