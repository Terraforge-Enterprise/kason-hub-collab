import type { LucideIcon } from "lucide-react";
import { Home, Building2, Snowflake, FileText, Wallet } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { formatDate, formatMoney, formatPeriodMonth } from "@/components/format";
import { PHASE2_STATUS_TONES } from "@kason/shared";

// Mirrors the API's DraftInvoiceRow (apps/api/.../auto-draft.types.ts). The
// list/detail JSON does NOT include a `currency` field — amounts are MYR
// (formatMoney defaults to MYR). periodMonth is nullable.
// CONTRACT: unitCode/propertyName MUST come back from GET /billing/invoices — the
// queue renders them under every tenant-side row so an admin can tell two rows for
// the same party apart. Null is legitimate ONLY for owner-side rows (no tenancy) or
// an unresolvable unit; a null on a TENANT row means the batched unit join regressed.
export type DraftInvoiceListItem = {
  id: string;
  invoiceNumber: string;
  partyName: string;
  invoiceType: string;
  periodMonth: string | null;
  totalAmount: number;
  status: string;
  updatedAt: string;
  unitCode?: string | null;
  propertyName?: string | null;
};

// ── Invoice-type presentation ────────────────────────────────────────────────
// The API sends raw enum values ("tenant_rental", "owner_statement", …). Users
// should never see those underscores — every surface renders a human label, a
// colour-coded badge, and whether the row is an INVOICE or a STATEMENT.
export type InvoiceTypeMeta = {
  /** Human label incl. the document kind, e.g. "Rental Invoice" / "Owner Statement". */
  label: string;
  /** Plural for tab headers, e.g. "Rental Invoices". */
  plural: string;
  variant: "sky" | "gold" | "emerald" | "outline";
  Icon: LucideIcon;
};

export const INVOICE_TYPE_META: Record<string, InvoiceTypeMeta> = {
  tenant_rental: { label: "Rental Invoice", plural: "Rental Invoices", variant: "sky", Icon: Home },
  tenant_aircon: { label: "Aircon Invoice", plural: "Aircon Invoices", variant: "emerald", Icon: Snowflake },
  owner_statement: { label: "Owner Statement", plural: "Owner Statements", variant: "gold", Icon: Building2 },
  // Move-in deposits. Wallet mirrors the "Deposits & parking" section icon on the
  // edit-unit form, so the same money reads the same across the two surfaces.
  tenant_deposit: { label: "Rental Deposits", plural: "Rental Deposits", variant: "outline", Icon: Wallet },
};

/** Resolve presentation for any invoiceType, prettifying unknown values instead of
 * leaking a raw underscore enum. */
export function invoiceTypeMeta(type: string): InvoiceTypeMeta {
  const known = INVOICE_TYPE_META[type];
  if (known) return known;
  const pretty = type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { label: pretty, plural: `${pretty}s`, variant: "outline", Icon: FileText };
}

/** The type values that get their own tab, in display order. */
export const INVOICE_TYPE_ORDER = ["tenant_rental", "owner_statement", "tenant_aircon", "tenant_deposit"] as const;

type Props = {
  invoices: DraftInvoiceListItem[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onRowClick: (id: string) => void;
};

export function DraftApprovalsTable({
  invoices,
  selectedIds,
  onSelectionChange,
  onRowClick,
}: Props) {
  const allSelected = invoices.length > 0 && selectedIds.length === invoices.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < invoices.length;

  function toggleAll() {
    onSelectionChange(allSelected ? [] : invoices.map((inv) => inv.id));
  }

  function toggleRow(id: string) {
    onSelectionChange(
      selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id],
    );
  }

  return (
    <TableWrap>
      <DataTable>
        <TableHead>
          <tr>
            <HeadCell className="w-10">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all visible invoices"
              />
            </HeadCell>
            <HeadCell>Document</HeadCell>
            <HeadCell>Billed to</HeadCell>
            <HeadCell className="hidden xl:table-cell">Period</HeadCell>
            <HeadCell className="text-right">Total</HeadCell>
            <HeadCell>Status</HeadCell>
            <HeadCell className="hidden lg:table-cell">Updated</HeadCell>
          </tr>
        </TableHead>
        <tbody>
          {invoices.length === 0 ? (
            <EmptyRow colSpan={7} label="No draft invoices match the current filters." />
          ) : (
            invoices.map((inv) => {
              const tone =
                PHASE2_STATUS_TONES.invoice[
                  inv.status as keyof typeof PHASE2_STATUS_TONES.invoice
                ] ?? "slate";
              const m = invoiceTypeMeta(inv.invoiceType);
              return (
                <Row key={inv.id}>
                  <BodyCell>
                    <Checkbox
                      checked={selectedIds.includes(inv.id)}
                      onCheckedChange={() => toggleRow(inv.id)}
                      aria-label={`Select ${m.label} ${inv.invoiceNumber}`}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </BodyCell>
                  {/* Document — states WHAT it is (invoice vs statement) + its code. */}
                  <BodyCell>
                    <button
                      type="button"
                      className="flex flex-col items-start gap-1 text-left"
                      onClick={() => onRowClick(inv.id)}
                    >
                      <Badge variant={m.variant} className="inline-flex items-center gap-1">
                        <m.Icon className="h-3 w-3" />
                        {m.label}
                      </Badge>
                      <span className="font-mono text-xs text-[var(--text-muted)] transition group-hover:text-[var(--text-primary)]">
                        {inv.invoiceNumber}
                      </span>
                    </button>
                  </BodyCell>
                  {/* Billed to — the TENANT and the UNIT. The name alone cannot identify
                      a row: two tenancies can share a display name, and one tenant can
                      hold several units, so "Demo Tenant" twice was unresolvable. */}
                  <BodyCell>
                    <button
                      type="button"
                      className="flex flex-col items-start text-left"
                      onClick={() => onRowClick(inv.id)}
                    >
                      <span className="font-medium text-[var(--text-primary)] hover:underline">
                        {inv.partyName}
                      </span>
                      {inv.unitCode ? (
                        <span className="text-xs text-[var(--text-muted)]">
                          {inv.unitCode}
                          {inv.propertyName ? ` · ${inv.propertyName}` : ""}
                        </span>
                      ) : null}
                    </button>
                  </BodyCell>
                  <BodyCell className="hidden xl:table-cell tabular-nums text-[var(--text-secondary)]">
                    {formatPeriodMonth(inv.periodMonth)}
                  </BodyCell>
                  <BodyCell className="text-right font-semibold tabular-nums">
                    {formatMoney(inv.totalAmount)}
                  </BodyCell>
                  <BodyCell>
                    <StatusPill tone={tone}>{inv.status}</StatusPill>
                  </BodyCell>
                  <BodyCell className="hidden lg:table-cell whitespace-nowrap text-[var(--text-secondary)]">
                    {formatDate(inv.updatedAt)}
                  </BodyCell>
                </Row>
              );
            })
          )}
        </tbody>
      </DataTable>
    </TableWrap>
  );
}
