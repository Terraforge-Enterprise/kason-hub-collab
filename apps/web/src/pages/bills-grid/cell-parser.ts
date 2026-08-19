// Bills & Expenses Grid — amount-cell parser (UI Task 4, spec R31). Excel
// affordance list requires amount cells to accept literal numbers ONLY: a
// formula like `=SUM(A1:A3)` must be rejected before it ever reaches the
// staged-edit buffer, so a bulk paste can never smuggle a live spreadsheet
// formula into a money field.
export type ParseError = { ok: false; message: "Amounts only" };
export type ParseOk = { ok: true; value: number };
const AMOUNT = /^\d+(\.\d{1,2})?$/;
/** Amount cells accept NO formula — literal numbers only (R31). */
export function parseAmountCell(raw: string): ParseOk | ParseError {
  const s = raw.trim();
  if (s === "") return { ok: true, value: 0 };
  if (s.startsWith("=")) return { ok: false, message: "Amounts only" };
  if (!AMOUNT.test(s)) return { ok: false, message: "Amounts only" };
  return { ok: true, value: Number(s) };
}
