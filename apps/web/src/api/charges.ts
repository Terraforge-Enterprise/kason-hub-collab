// Typed react-query hook for a party's OUTSTANDING charges, used to seed the
// receive-payment allocation grid. Backs GET /billing/charges filtered to one
// party, outstanding-only. Money on charges travels as NUMBERS (unlike the
// 2-dp decimal STRINGS elsewhere in billing).
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

/**
 * One row of the GET /billing/charges response — mirrors the server DTO
 * (apps/web/src/pages/billing/charges-table.tsx `ChargeListItem`). Note the
 * "description"-ish field is `chargeType`, the date is `dueDate` (there is no
 * `billingMonth`), and `amount` / `outstandingAmount` are NUMBERS.
 */
export type ChargeListItem = {
  id: string;
  chargeNumber: string;
  partyName: string;
  tenancyCode: string | null;
  unitCode: string | null;
  chargeType: string;
  description: string | null;
  status: string;
  dueDate: string;
  billingMonth: string | null;
  amount: number;
  outstandingAmount: number;
  currency: string;
  invoiceNumber: string | null;
  /** Issued BillingDocument number (IVTEN/DEP…); null = draft or pre-cutover. */
  documentNumber: string | null;
};

/**
 * A party's open (outstanding) charges — GET
 * /billing/charges?partyId=&outstandingOnly=true&pageSize=100. The shared billing
 * query contract caps pageSize at 100; using 200 makes the API reject the preview
 * with HTTP 400. Additional pages are fetched so Total Outstanding never omits
 * an older open charge. DISABLED when `partyId === null`. Returns the
 * charge list items (server response is `{ data: ChargeListItem[], total }` because
 * pageSize is present — only `.data` is surfaced).
 */
export function usePartyOpenCharges(partyId: string | null) {
  return useQuery({
    queryKey: ["billing", "charges", "open", partyId],
    queryFn: async (): Promise<ChargeListItem[]> => {
      const base = `/billing/charges?partyId=${encodeURIComponent(partyId!)}&outstandingOnly=true&pageSize=100`;
      const first = await apiFetch<{ data: ChargeListItem[]; total: number }>(`${base}&page=1`);
      const pageCount = Math.ceil(first.total / 100);
      if (pageCount <= 1) return first.data;
      const rest = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, index) =>
          apiFetch<{ data: ChargeListItem[]; total: number }>(`${base}&page=${index + 2}`),
        ),
      );
      return [first.data, ...rest.map((page) => page.data)].flat();
    },
    enabled: partyId !== null,
  });
}
