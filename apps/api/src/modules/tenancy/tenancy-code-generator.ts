// Generates the next TEN-{year}-NNNN code by taking MAX(suffix) over all
// tenancies in this org for the current year.
//
// Why we do max-in-JS instead of `orderBy: { tenancyCode: "desc" }`:
// the orderBy is lexicographic, but the codes in the DB can have mixed-width
// numeric suffixes (e.g. seed data writes 3-digit "TEN-2026-010" while this
// generator emits 4-digit "TEN-2026-0011"). Lex order then ranks "TEN-2026-010"
// above "TEN-2026-0011", so the generator would keep emitting "0011" and
// collide on the (organizationId, tenancyCode) unique index. parseInt-then-max
// in JS treats the suffix numerically and is robust to width drift.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateTenancyCodeTx(tx: any, orgId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `TEN-${year}-`;
  const rows = (await tx.tenancy.findMany({
    where: {
      organizationId: orgId,
      tenancyCode: { startsWith: prefix },
    },
    select: { tenancyCode: true },
  })) as { tenancyCode: string }[];
  let maxSeq = 0;
  for (const row of rows) {
    const n = parseInt(row.tenancyCode.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}
