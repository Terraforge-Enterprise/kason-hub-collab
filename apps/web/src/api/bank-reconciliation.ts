import { apiFetch } from "@/lib/api-client";

export type BankAccount = { id: string; bankName: string; nickname: string; maskedAccountNumber: string | null };
export type BankTransaction = {
  id: string; accountId: string; transactionDate: string; description: string; reference: string | null;
  debit: string; credit: string; balance: string | null; status: "unmatched" | "matched" | "review";
  apartmentId: string | null; responsibility: "tenant" | "owner" | "company" | "pending" | null;
  collectionCategory: "rental" | "deposit" | "tenant_expense" | "owner_payment" | "management_fee" | "other" | "pending" | null;
  transactionCategory: "non_operational_transfer" | "internal_bank_transfer" | null;
  destinationAccount: string | null;
  transferPurpose: "payroll_funding" | "head_office_funding" | "reserve_transfer" | "tax_funding" | "other" | null;
  internalTransferPairId: string | null;
  gridExpenseId: string | null; chargeRequired: boolean; matchNotes: string | null; unitLabel: string | null;
  linkedPaymentId?: string | null;
  account: { bankName: string; nickname: string; maskedAccountNumber: string | null };
  costAllocations: Array<{ id: string; amount: string; targetType: "grid_expense" | "employee_claim"; unitLabel: string | null; periodMonth: string | null; bearer: string | null; description: string | null; reference: string | null }>;
  collectionAllocations: Array<{ id: string; amount: string; paymentNumber: string; partyName: string; chargeNumber: string; chargeType: string; category: string | null; description: string; periodMonth: string | null; unitLabel: string | null }>;
};
export type MatchCandidates = {
  apartments: Array<{ id: string; label: string }>;
  expenses: Array<{ id: string; apartmentId: string; periodMonth: string; bearer: "tenant" | "owner"; description: string; amount: string; actualCost: string | null; paidCost: string; costPaymentStatus: string }>;
  employeeClaims: Array<{ id: string; expenseNumber: string; claimantName: string | null; description: string | null; totalAmount: string; reimbursedAmount: string; reimbursementStatus: string }>;
  collectionCharges: Array<{ id: string; chargeNumber: string; apartmentId: string | null; partyId: string; partyName: string; unitLabel: string | null; chargeType: string; categoryName: string | null; description: string | null; dueDate: string; originalAmount: string; outstandingAmount: string }>;
  bankTransfers: Array<{ id: string; transactionDate: string; description: string; debit: string; credit: string; accountId: string; accountLabel: string; status: string }>;
};
export type ReconSummary = { unmatched: { count: number; amount: string }; review: { count: number; amount: string }; chargeRequired: { count: number; amount: string }; nonOperationalTransfers: { count: number; amount: string } };
export type ImportLine = { transactionDate: string; description: string; reference?: string; debit?: number; credit?: number; balance?: number };
export type ImportPreview = { rows: Array<{ index: number; duplicate: boolean; hasBalance: boolean; balanceBreak: boolean }>; total: number; newCount: number; duplicates: number; missingBalance: number; balanceBreaks: number; direction: "oldest_first" | "newest_first"; canImport: boolean };

export async function listBankAccounts() { return (await apiFetch<{ data: BankAccount[] }>("/bank-reconciliation/accounts")).data; }
export async function addBankAccount(input: { bankName: "Maybank" | "Hong Leong Bank" | "Other"; nickname: string; maskedAccountNumber?: string }) { return (await apiFetch<{ data: BankAccount }>("/bank-reconciliation/accounts", { method: "POST", body: JSON.stringify(input) })).data; }
export async function importBankTransactions(input: { accountId: string; source: "manual" | "paste" | "csv"; transactions: ImportLine[] }) { return (await apiFetch<{ data: { imported: number; duplicates: number } }>("/bank-reconciliation/imports", { method: "POST", body: JSON.stringify(input) })).data; }
export async function previewBankTransactions(input: { accountId: string; transactions: ImportLine[] }) { return (await apiFetch<{ data: ImportPreview }>("/bank-reconciliation/imports/preview", { method: "POST", body: JSON.stringify(input) })).data; }
export async function listBankTransactions(status: string, q = "", accountId = "") { const qs = new URLSearchParams({ status, ...(q ? { q } : {}), ...(accountId ? { accountId } : {}) }); return (await apiFetch<{ data: BankTransaction[] }>(`/bank-reconciliation/transactions?${qs}`)).data; }
export async function getBankMatchCandidates() { return (await apiFetch<{ data: MatchCandidates }>("/bank-reconciliation/candidates")).data; }
export async function getBankReconciliationSummary() { return (await apiFetch<{ data: ReconSummary }>("/bank-reconciliation/summary")).data; }
export type NewUnitCostItem = { apartmentId: string; billingMonth: string; bearer: "owner" | "tenant"; costType: "tnb" | "water" | "wifi" | "cleaning" | "maintenance" | "recurring" | "repair" | "other"; description: string; amount: string; withSST: boolean };
export async function categorizeBankTransaction(id: string, input: { apartmentId?: string | null; responsibility?: "tenant" | "owner" | "company" | "pending" | null; collectionCategory?: "rental" | "deposit" | "tenant_expense" | "owner_payment" | "management_fee" | "other" | "pending" | null; transactionCategory?: "non_operational_transfer" | "internal_bank_transfer" | null; counterpartTransactionId?: string; destinationAccount?: string | null; transferPurpose?: "payroll_funding" | "head_office_funding" | "reserve_transfer" | "tax_funding" | "other" | null; gridExpenseId?: string | null; matchNotes?: string; allocations?: Array<{ chargeId: string; allocatedAmount: string }>; costAllocations?: Array<{ targetType: "grid_expense" | "employee_claim"; targetId: string; allocatedAmount: string }>; unitCostItems?: NewUnitCostItem[] }) { return (await apiFetch<{ data: BankTransaction }>(`/bank-reconciliation/transactions/${id}/categorize`, { method: "PATCH", body: JSON.stringify(input) })).data; }
