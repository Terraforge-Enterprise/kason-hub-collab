import { API_BASE, ApiError, extractApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";

export async function downloadAllAccountingTransactions(): Promise<void> {
  const token = getAdminToken();
  const response = await fetch(`${API_BASE}/accounting-export/all-transactions.xlsx`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsed = extractApiError(body, response.status);
    throw new ApiError(parsed.message, response.status, parsed.code, body);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "KAEN-ACCOUNTING-TRANSACTIONS.xlsx";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
