// The single formatter for a billing-document line's unit identity.
//
// A COMBINED owner statement mints ONE document spanning every unit the owner
// holds, so the document-level unitCode is null by design and each line must
// name its own unit. Both renderers (the web invoice drawer and the PDF) call
// this, so a line can never read one way on screen and another on the document
// the owner actually receives.
//
// WHOLE apartment  → the apartment code alone ("A-01-01"); the apartment IS the
//                    let unit, so appending its listingType would be noise.
// PARTITIONED      → apartment code + room ("B-02-07 · Master Room"); several
//                    rooms share one apartment code, so the code alone would
//                    render two different rooms identically — the exact
//                    ambiguity this exists to remove.

/** The unit shape this label needs — a Charge's `unit` relation (Prisma model
 * `Listing`, mapped to the "Unit" table) narrowed to the display fields. */
export type LineUnitSource = {
  listingType: string;
  apartment: { unitCode: string; listingMode: string };
} | null;

/** Human label for the unit a document line bills, or null when the line has no
 * unit (a charge-less line, or a charge carrying no unitId). */
export function formatLineUnitLabel(unit: LineUnitSource): string | null {
  if (!unit) return null;
  const { unitCode, listingMode } = unit.apartment;
  if (listingMode !== "PARTITIONED") return unitCode;
  const room = unit.listingType.trim();
  return room ? `${unitCode} · ${room}` : unitCode;
}
