// Line items tab body (invoice-adjustments Phase 2.2, spec §7-A3) — the
// server-derived per-line adjustment breakdown: # · Description · Original ·
// Adjustments · Adjusted · Paid · Outstanding. Every money value rendered here
// is a field the server already computed; this component NEVER adds, subtracts,
// or otherwise re-derives a total from other fields — it only formats what
// `BillingDocumentLineDto` hands it (see `formatSignedRM`/`formatSignedNoteAmount`
// in document-helpers.ts, which split a sign+magnitude for display, not math).
import type { BillingDocumentLineDto } from "@kason/shared";
import { foldTaxLines } from "@kason/shared";
import { TableWrap, DataTable, TableHead, HeadCell, BodyCell, Row, EmptyRow } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { formatRM } from "@/components/format";
import { docTypeLabel, formatSignedRM, formatSignedNoteAmount, adjustmentToneClass } from "./document-helpers";

export function LineItemsTab({
  lines: rawLines,
  isLoading,
}: {
  lines: BillingDocumentLineDto[];
  isLoading: boolean;
}) {
  // Fold the SST sibling into the base line it taxes, so the Amount column foots to
  // Subtotal and the same RM is not printed twice. Done HERE rather than by the
  // caller so any future mount of this table is correct by construction — and never
  // on the way into the Record-Payment form / CN-DN picker, which need the tax line.
  const lines = foldTaxLines(rawLines);

  if (isLoading && lines.length === 0) {
    return <div className="h-24 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <TableWrap>
      <DataTable>
        <TableHead>
          <tr>
            <HeadCell className="w-10">#</HeadCell>
            <HeadCell>Description</HeadCell>
            <HeadCell className="text-right">Original</HeadCell>
            {/* Per-line tax made a COLUMN (user ask 2026-08-07): the rate was only
                discoverable inside the description meta-line, and the amount not at
                all — an SST-bearing line read as if untaxed. Server value verbatim
                (BillingDocumentLineDto.adjustedSstAmount — the note-adjusted figure,
                which equals sstAmount when the charge carries no notes); this
                component still derives nothing. */}
            <HeadCell className="text-right">SST</HeadCell>
            <HeadCell className="text-right">Adjustments</HeadCell>
            <HeadCell className="text-right">Adjusted</HeadCell>
            <HeadCell className="text-right">Paid</HeadCell>
            <HeadCell className="text-right">Outstanding</HeadCell>
          </tr>
        </TableHead>
        <tbody>
          {lines.length === 0 ? (
            <EmptyRow colSpan={8} label="No line items." />
          ) : (
            lines.flatMap((l, i) => {
              const outstanding = Number(l.outstanding ?? l.amount);
              const paid = Number(l.paid ?? 0);
              const fullyPaid = l.chargeId !== null && outstanding <= 0.005;
              const sstRate = Number(l.sstRate);
              // Original/Adjusted are formatted straight from the server strings —
              // NEVER `original + net` computed here (§7-A3).
              const original = l.originalAmount ?? l.amount;
              const adjusted = l.adjustedAmount ?? l.amount;
              // Server-derived SST AFTER active notes. Rendering the raw `sstAmount`
              // showed the full original tax on a line that had been part-credited —
              // a RM 1.00 @ 8% line credited by RM 0.50 still printed RM 0.08.
              const sst = l.adjustedSstAmount ?? l.sstAmount;
              const net = formatSignedRM(l.netAdjustmentAmount ?? "0.00");
              const hasAdjustments = (l.adjustments?.length ?? 0) > 0;
              const prorated = l.allocationBasis === "prorated";

              const mainRow = (
                <Row key={l.id}>
                  <BodyCell className="align-top text-muted-foreground">{i + 1}</BodyCell>
                  <BodyCell>
                    <span className="font-medium text-foreground">{l.description}</span>
                    {/* Which unit this line bills, leading the meta line. On a
                        COMBINED owner statement the header's Property/Unit both
                        read "—" (the document spans every unit), so this is the
                        only thing separating otherwise-identical lines such as
                        three "Management fee" rows. Null ⇒ the line has no unit
                        (charge-less line, or a charge without a unitId) and the
                        meta line simply starts at the category. */}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {l.unitCode ? (
                        <>
                          <span className="font-semibold text-foreground/80">{l.unitCode}</span>
                          {" · "}
                        </>
                      ) : null}
                      {l.categoryName}
                      {sstRate > 0 ? ` · SST ${sstRate}%` : ""}
                    </span>
                  </BodyCell>
                  <BodyCell className="align-top text-right tabular-nums">{formatRM(Number(original))}</BodyCell>
                  <BodyCell className="align-top text-right tabular-nums">
                    {Number(sst) > 0 ? (
                      formatRM(Number(sst))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </BodyCell>
                  <BodyCell className="align-top text-right tabular-nums">
                    {hasAdjustments ? (
                      <span className={adjustmentToneClass(net.tone)}>{net.text}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </BodyCell>
                  <BodyCell className="align-top text-right tabular-nums font-medium text-foreground">
                    {formatRM(Number(adjusted))}
                  </BodyCell>
                  <BodyCell className="align-top text-right tabular-nums text-muted-foreground">
                    {formatRM(paid)}
                  </BodyCell>
                  <BodyCell className="align-top text-right">
                    <div className="flex flex-col items-end gap-1">
                      <span className="font-medium tabular-nums text-foreground">{formatRM(outstanding)}</span>
                      <div className="flex items-center gap-1">
                        {fullyPaid ? <Badge variant="sky" className="w-fit">Paid</Badge> : null}
                        {prorated ? (
                          <Badge
                            variant="outline"
                            className="w-fit"
                            title="This charge is split across multiple lines on this document; Paid/Outstanding are proportionally allocated."
                          >
                            Prorated
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </BodyCell>
                </Row>
              );

              if (!hasAdjustments) return [mainRow];

              const childRows = l.adjustments.map((adj) => (
                <tr key={adj.noteId} className="border-b border-[var(--border)] bg-muted/30 text-xs">
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-muted-foreground">
                    <span className="pl-3">
                      ↳ {docTypeLabel(adj.docType)} {adj.documentNumber}
                    </span>
                  </td>
                  {/* Original + SST stay empty — a note row only carries its signed amount. */}
                  <td className="px-4 py-2" colSpan={2} />
                  <td className={`px-4 py-2 text-right tabular-nums ${adjustmentToneClass(adj.docType === "credit_note" ? "credit" : "debit")}`}>
                    {formatSignedNoteAmount(adj.docType, adj.amountCents)}
                  </td>
                  <td className="px-4 py-2" colSpan={3} />
                </tr>
              ));

              return [mainRow, ...childRows];
            })
          )}
        </tbody>
      </DataTable>
    </TableWrap>
  );
}
