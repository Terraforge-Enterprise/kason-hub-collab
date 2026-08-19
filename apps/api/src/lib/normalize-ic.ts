/** MUST mirror the Party.idNumberNormalized generated column exactly:
 *  upper(regexp_replace(coalesce(idNumber,''),'[^A-Za-z0-9]','','g'))
 *  (packages/db/prisma/migrations/20260706120000_party_id_number_normalized).
 *  Used to match a Party by normalized NRIC/passport number in application
 *  code, outside the DB (e.g. reservation -> tenancy conversion). Any drift
 *  from the SQL expression above is a real bug -- see
 *  normalize-ic-column.integration.test.ts for the SQL<->TS parity proof. */
export function normalizeIc(value: string | null | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
