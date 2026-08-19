// scripts/cleanup-per-unit-owner-statements.ts
//
// ONE-TIME CLEANUP — void orphan per-unit owner statements.
//
// Owner statements are now combined-only (one combined Invoice per owner/month,
// apartmentId=null). Per-unit Invoices (apartmentId IS NOT NULL) were created by
// the retired generateOwnerMonthStatementsService and are now orphans. They must
// be VOIDED (reversible, per DEC-4) — NOT hard-deleted. The PDF storage objects
// are KEPT so the void is fully reversible via the admin UI.
//
// Target rows:
//   Invoice WHERE invoiceType = 'owner_statement'
//          AND   apartmentId  IS NOT NULL
//          AND   status       NOT IN ('void', 'paid')
//
// The --apply path is DOUBLE-GUARDED:
//   1. CLI flag:    --apply
//   2. Env var:     CLEANUP_CONFIRM=yes
// Both must be present. If either is missing the script exits after the dry-run
// table regardless of what else was passed.
//
// Usage:
//   # Dry-run (safe, mutates nothing):
//   DATABASE_URL=<url> node_modules/.bin/tsx scripts/cleanup-per-unit-owner-statements.ts
//
//   # Apply (voids the target rows; keep storage objects):
//   DATABASE_URL=<url> CLEANUP_CONFIRM=yes node_modules/.bin/tsx scripts/cleanup-per-unit-owner-statements.ts --apply

import "dotenv/config";
import { db } from "@kason/db";
import { voidStatementService } from "../apps/api/src/modules/owner-billing/index";
import { resolveSystemActor } from "../apps/api/src/modules/billing/auto-draft.repository";

const INVOICE_TYPE = "owner_statement";

async function main() {
  const apply = process.argv.includes("--apply");
  const confirmed = process.env.CLEANUP_CONFIRM === "yes";

  try {
    // ── Query target rows ───────────────────────────────────────────────────
    const targets = await db.invoice.findMany({
      where: {
        invoiceType: INVOICE_TYPE,
        apartmentId: { not: null },
        status: { notIn: ["void", "paid"] },
      },
      select: {
        id: true,
        organizationId: true,
        invoiceNumber: true,
        ownerPartyId: true,
        apartmentId: true,
        totalAmount: true,
        status: true,
        pdfKey: true,
      },
      orderBy: [{ organizationId: "asc" }, { invoiceNumber: "asc" }],
    });

    // ── Print dry-run table ─────────────────────────────────────────────────
    const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

    if (targets.length === 0) {
      console.log("OK — no orphan per-unit owner_statement rows found. Nothing to void.");
      return;
    }

    console.log(`Found ${targets.length} orphan per-unit owner_statement Invoice(s) to void:\n`);
    console.log(
      `${"invoiceNumber".padEnd(28)} ${"ownerPartyId".padEnd(36)} ${"apartmentId".padEnd(36)} ${"status".padEnd(10)} ${"totalAmount".padStart(12)}  pdfKey`,
    );
    console.log("-".repeat(140));
    for (const r of targets) {
      console.log(
        `${pad(r.invoiceNumber, 28)} ${pad(r.ownerPartyId ?? "(none)", 36)} ${pad(r.apartmentId ?? "(none)", 36)} ${pad(r.status, 10)} ${String(Number(r.totalAmount).toFixed(2)).padStart(12)}  ${r.pdfKey ?? "(no PDF)"}`,
      );
    }
    console.log("-".repeat(140));

    if (!apply || !confirmed) {
      const missing: string[] = [];
      if (!apply) missing.push("--apply flag");
      if (!confirmed) missing.push("CLEANUP_CONFIRM=yes env var");
      console.log(
        `\nDRY-RUN: would void ${targets.length} statement(s). Missing guard(s): ${missing.join(" and ")}.`,
      );
      console.log(
        `Re-run with CLEANUP_CONFIRM=yes <tsx> scripts/cleanup-per-unit-owner-statements.ts --apply to apply.`,
      );
      console.log("NOTE (DEC-4): void is REVERSIBLE — PDF storage objects are kept intact.");
      return;
    }

    // ── Apply path (DOUBLE-GUARDED) ─────────────────────────────────────────
    console.log(`\nAPPLYING: voiding ${targets.length} statement(s) (storage objects preserved per DEC-4)...\n`);

    let voided = 0;
    let skipped = 0;

    // Group by org so we resolve the system actor once per org.
    const byOrg = new Map<string, typeof targets>();
    for (const t of targets) {
      const slot = byOrg.get(t.organizationId) ?? [];
      slot.push(t);
      byOrg.set(t.organizationId, slot);
    }

    for (const [orgId, rows] of byOrg) {
      const actor = await resolveSystemActor(orgId);
      if (!actor) {
        console.warn(
          `  SKIP org ${orgId} — no admin user found (resolveSystemActor returned null). ${rows.length} statement(s) left un-voided.`,
        );
        skipped += rows.length;
        continue;
      }

      const ctx = {
        orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
      };

      for (const r of rows) {
        const result = await voidStatementService(ctx, r.id);
        if (result.ok) {
          console.log(`  VOIDED  ${r.invoiceNumber} (id: ${r.id}, was: ${r.status})`);
          voided++;
        } else {
          console.warn(
            `  SKIP    ${r.invoiceNumber} (id: ${r.id}) — voidStatementService returned ${result.status}: ${result.error}`,
          );
          skipped++;
        }
      }
    }

    console.log(`\nDone. Voided: ${voided}  Skipped: ${skipped}`);
    if (skipped > 0) {
      console.warn(`WARNING: ${skipped} statement(s) were not voided (see SKIP lines above).`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
