/**
 * Settings → Document Series (accounting-docs P1, spec §4.5 numbering config).
 *
 * Compact TABLE view (mirrors inventory/unit-types-section.tsx): edits the
 * DocumentSeries rows (prefix / padding / include-year) that Plan 2's
 * mintDocumentNumberTx uses to format BillingDocument numbers
 * (IVTEN / IVOWN / DEP / CN / RN). The route + nav entry exist only when
 * ENABLE_PHASE2_BILLING_DOCS is on.
 * Optimistic concurrency: expectedUpdatedAt → 409 → toast + refetch.
 */
import { useState } from "react";
import { Hash } from "lucide-react";
import { toast } from "sonner";
import type { DocumentSeriesDto } from "@kason/shared";
import { useDocumentSeries, useUpdateDocumentSeries } from "@/api/charge-categories";
import { PageHeader } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { SelectInput, TextInput } from "@/components/form-ui";

function previewNumber(prefix: string, padding: number, includeYear: boolean): string {
  const counter = "1".padStart(Math.max(1, padding), "0");
  return includeYear ? `${prefix}-${new Date().getFullYear()}-${counter}` : `${prefix}-${counter}`;
}

function SeriesRow({ series }: { series: DocumentSeriesDto }) {
  const update = useUpdateDocumentSeries();
  const [prefix, setPrefix] = useState(series.prefix);
  const [padding, setPadding] = useState(String(series.padding));
  const [includeYear, setIncludeYear] = useState(series.includeYear ? "true" : "false");

  const paddingNum = Number(padding);
  const dirty =
    prefix !== series.prefix ||
    paddingNum !== series.padding ||
    (includeYear === "true") !== series.includeYear;
  const valid = prefix.trim().length > 0 && Number.isInteger(paddingNum) && paddingNum >= 1 && paddingNum <= 10;

  function save() {
    update.mutate(
      {
        id: series.id,
        ...(prefix !== series.prefix ? { prefix: prefix.trim() } : {}),
        ...(paddingNum !== series.padding ? { padding: paddingNum } : {}),
        ...((includeYear === "true") !== series.includeYear ? { includeYear: includeYear === "true" } : {}),
        expectedUpdatedAt: series.updatedAt,
      },
      {
        onSuccess: () => toast.success(`${series.code} series updated`),
        // 409 stale token: the hook's onSuccess-invalidation refetches the list
        // on the NEXT success; on error we surface the message and the user
        // retries against the refreshed row.
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Failed to update ${series.code}`),
      },
    );
  }

  return (
    <tr className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]">
      {/* Series code */}
      <td className="px-4 py-3.5 font-semibold text-foreground">{series.code}</td>
      {/* Next number preview */}
      <td className="px-4 py-3.5">
        <span className="font-mono text-xs text-foreground/80">
          {previewNumber(prefix || series.code, valid ? paddingNum : series.padding, includeYear === "true")}
        </span>
      </td>
      {/* Prefix — editable */}
      <td className="w-32 px-4 py-3.5">
        <TextInput aria-label="Prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} required />
      </td>
      {/* Padding — editable */}
      <td className="w-28 px-4 py-3.5">
        <TextInput
          aria-label="Padding"
          type="number"
          min={1}
          max={10}
          value={padding}
          onChange={(e) => setPadding(e.target.value)}
          required
        />
      </td>
      {/* Year segment — editable */}
      <td className="w-40 px-4 py-3.5">
        <SelectInput aria-label="Year segment" value={includeYear} onChange={(e) => setIncludeYear(e.target.value)}>
          <option value="false">No year</option>
          <option value="true">Include year</option>
        </SelectInput>
      </td>
      {/* Actions */}
      <td className="w-28 px-4 py-3.5 text-right">
        <Button type="button" size="sm" disabled={!dirty || !valid || update.isPending} onClick={save}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </td>
    </tr>
  );
}

export default function DocumentSeriesSettingsPage() {
  const { data, isLoading, isError } = useDocumentSeries();
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Document Series"
        icon={Hash}
        description="Numbering format per document series (IVTEN, IVOWN, DEP, CN, RN) — prefix, counter padding, and optional year segment. Numbers are minted when documents are issued; existing numbers never change."
      />
      {isLoading ? (
        <div className="h-64 animate-pulse rounded-lg border border-border/30 bg-muted/50" />
      ) : isError ? (
        <p className="text-sm text-rose-600">Failed to load document series. Please refresh.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="w-32 px-4 py-3 font-semibold">Series</th>
                  <th className="px-4 py-3 font-semibold">Next number</th>
                  <th className="w-32 px-4 py-3 font-semibold">Prefix</th>
                  <th className="w-28 px-4 py-3 font-semibold">Padding</th>
                  <th className="w-40 px-4 py-3 font-semibold">Year segment</th>
                  <th className="w-28 px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                      No document series.
                    </td>
                  </tr>
                ) : (
                  items.map((s) => <SeriesRow key={s.id} series={s} />)
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Padding is the number of digits in the counter (1–10). Numbers are minted at issue time; existing
            numbers never change.
          </p>
        </>
      )}
    </div>
  );
}
