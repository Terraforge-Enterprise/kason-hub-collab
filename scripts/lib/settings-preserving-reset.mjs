/**
 * Settings-preserving database reset — "configured but empty".
 *
 * Wipes all transactional data while preserving org-level settings and the
 * operator logins, so the environment starts configured but with empty
 * registers. Extracted from scripts/demo-reset.mjs so the dev-demo reset and
 * the UAT reset cannot drift apart — one engine, one verified implementation.
 *
 * Everything destructive runs in ONE transaction: save -> truncate -> restore
 * -> verify -> commit. Any failure (including a failed verification) rolls the
 * whole thing back, so a partial wipe is not a reachable state.
 *
 * Callers supply only the target. See db-targets.mjs for the safety guard.
 */
import { guardTarget, normalizeDsn } from "./db-targets.mjs";

/**
 * Org-level settings preserved across the wipe.
 * Ordered for restore: FK parents before children.
 *   Organization → everything (CASCADE)
 *   User → RoleAssignment
 *   DocumentSeries → ChargeCategory (seriesId, onDelete RESTRICT)
 *   RenovationPackage → RenovationPackageSplit
 *   SalesClaimDefault → SalesClaimDefaultSplit
 */
export const PRESERVE = [
  "Organization",
  "User", // filtered to userType='operator'
  "RoleAssignment",
  "DocumentSeries",
  "ChargeCategory",
  "RenovationPackage",
  "RenovationPackageSplit",
  "SalesClaimDefault",
  "SalesClaimDefaultSplit",
  "DocumentTemplate",
  "ChargeTemplate",
  "LateFeeRule",
  "EmailTemplate",
  "RoomType",
  "PropertyType",
  "SettingsLabel",
  "OrganizationCardSettings",
  "DraftConfig",
  "UtilityBillingConfig",
  // UnitBillsBearerConfig is deliberately NOT preserved: apartmentId is NOT NULL
  // into Apartment, which is wiped, so every row would dangle. Same rationale as
  // ManagementFeeConfig below. Per-apartment bearer config is meaningless with no
  // apartments; the org-level defaults live on UtilityBillingConfig.
  "TaTier",
  "AgentLevelThreshold",
  "AgentTierMapping",
  "RenovationStage",
  "WorkCategory",
  "Amenity",
];

/** Row filters applied when saving a preserved table. */
export const SAVE_FILTER = {
  User: `"userType" = 'operator'`,
};

/** Never truncated, never restored. */
export const UNTOUCHED = new Set(["_prisma_migrations"]);

/**
 * Post-wipe emptiness assertions — the registers an operator would look at.
 * ReferenceSequence is included deliberately: document numbering restarts at
 * 0001 rather than continuing the old environment's counters.
 * ManagementFeeConfig too — its ownerPartyId FK is NOT NULL into Party, which
 * is wiped; per-owner overrides are meaningless with no owners. The base rate
 * survives on Organization.managementFeePercent.
 */
export const MUST_BE_EMPTY = [
  "Unit", "Apartment", "Property", "Building", "Tenancy", "Party", "PartyRole",
  "Charge", "ChargeEvent", "BillingDocument", "BillingDocumentLine", "Invoice",
  "Payment", "PaymentAllocation", "UnitMonthLedger", "OwnerLedgerEntry",
  "AuditLog", "Task", "Ticket", "Sprint", "ReferenceSequence", "Document",
  "ManagementFeeConfig", "RecurringCharge", "UnitReservation",
  "UnitBillsBearerConfig",
];

/**
 * Pre-flight: find preserved rows whose foreign keys point at rows that will NOT
 * survive the wipe. Restoring those would violate the FK and roll the whole
 * transaction back at the very last step.
 *
 * Two ways a parent fails to survive:
 *   a) the parent table is not preserved at all (it gets truncated)
 *   b) the parent table IS preserved but SAVE_FILTER drops the specific row
 *      (e.g. RoleAssignment -> a non-operator User)
 *
 * Nullable FK columns are repaired by nulling them in the save set. NOT NULL
 * columns cannot be repaired — the table simply cannot be preserved, and we
 * abort BEFORE anything destructive rather than discovering it at COMMIT.
 *
 * This is detected against the live database rather than hardcoded, so it keeps
 * working as the schema evolves and at any migration level.
 */
export async function preflightFkHazards({ q, preserve }) {
  const preserveSet = new Set(preserve);

  const { rows: fks } = await q(`
    SELECT tc.table_name AS child, kcu.column_name AS col,
           ccu.table_name AS parent, ccu.column_name AS parent_col,
           c.is_nullable
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      JOIN information_schema.columns c
        ON c.table_schema = tc.table_schema AND c.table_name = tc.table_name
       AND c.column_name = kcu.column_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);

  const nullify = {};
  const blockers = [];

  for (const fk of fks) {
    if (!preserveSet.has(fk.child)) continue;

    // How many preserved rows would dangle?
    let dangling;
    if (!preserveSet.has(fk.parent)) {
      const childFilter = SAVE_FILTER[fk.child] ? ` AND ${SAVE_FILTER[fk.child]}` : "";
      dangling = (
        await q(
          `SELECT count(*)::int AS n FROM "${fk.child}"
            WHERE "${fk.col}" IS NOT NULL${childFilter}`,
        )
      ).rows[0].n;
    } else if (SAVE_FILTER[fk.parent]) {
      const childFilter = SAVE_FILTER[fk.child] ? ` AND ${SAVE_FILTER[fk.child]}` : "";
      dangling = (
        await q(
          `SELECT count(*)::int AS n FROM "${fk.child}" ch
            WHERE ch."${fk.col}" IS NOT NULL${childFilter}
              AND NOT EXISTS (
                SELECT 1 FROM "${fk.parent}" p
                 WHERE p."${fk.parent_col}" = ch."${fk.col}"
                   AND ${SAVE_FILTER[fk.parent]}
              )`,
        )
      ).rows[0].n;
    } else {
      continue; // parent fully preserved — safe
    }

    if (dangling === 0) continue;

    if (fk.is_nullable === "YES") {
      (nullify[fk.child] ||= []).push({ col: fk.col, parent: fk.parent, n: dangling });
    } else {
      blockers.push(
        `${fk.child}.${fk.col} -> ${fk.parent} is NOT NULL and ${dangling} preserved row(s) ` +
          `reference rows that will not survive. ${fk.child} cannot be preserved — ` +
          `remove it from PRESERVE (and add it to MUST_BE_EMPTY).`,
      );
    }
  }

  return { nullify, blockers };
}

/**
 * @param {object} opts
 * @param {object} opts.pg          the `pg` module (caller resolves it)
 * @param {string} opts.dsn         raw connection string
 * @param {string} opts.source      human label for where the DSN came from
 * @param {string} opts.expectRef   project ref this run is allowed to touch
 * @param {boolean} opts.dry        true = read-only report, no writes
 * @param {string} opts.envLabel    e.g. "UAT" — used in console output only
 */
export async function settingsPreservingReset({ pg, dsn, source, expectRef, dry, envLabel }) {
  guardTarget({ dsn, expectRef, source });

  const client = new pg.Client({
    connectionString: normalizeDsn(dsn),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    statement_timeout: 120_000,
  });

  const q = (sql, params) => client.query(sql, params);
  const count = async (t) => (await q(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;

  await client.connect();
  try {
    const who = await q(`SELECT current_database() AS db, current_user AS usr`);
    console.log(`Connected: db=${who.rows[0].db} user=${who.rows[0].usr}`);
    console.log(`Target env: ${envLabel}`);
    console.log(`Mode: ${dry ? "DRY-RUN (no writes)" : "COMMIT (destructive)"}\n`);

    const allTables = (
      await q(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
    ).rows.map((r) => r.tablename);

    const present = new Set(allTables);
    const preserve = PRESERVE.filter((t) => present.has(t));
    const absent = PRESERVE.filter((t) => !present.has(t));
    const preserveSet = new Set(preserve);
    const wipe = allTables.filter((t) => !preserveSet.has(t) && !UNTOUCHED.has(t));

    // ─── Classification report ───────────────────────────────────────────────
    console.log(`=== PRESERVE (${preserve.length} tables) ===`);
    for (const t of preserve) {
      const filter = SAVE_FILTER[t] ? ` WHERE ${SAVE_FILTER[t]}` : "";
      const n = (await q(`SELECT count(*)::int AS n FROM "${t}"${filter}`)).rows[0].n;
      const total = await count(t);
      const note = SAVE_FILTER[t] ? `  (of ${total} total — rest dropped)` : "";
      console.log(`  ${String(n).padStart(6)}  ${t}${note}`);
    }
    if (absent.length) {
      console.log(`\n  (absent at this migration level, skipped: ${absent.join(", ")})`);
    }

    console.log(`\n=== WIPE (${wipe.length} tables) ===`);
    const wipeCounts = [];
    for (const t of wipe) wipeCounts.push({ t, n: await count(t) });
    const nonEmpty = wipeCounts.filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    nonEmpty.forEach((x) => console.log(`  ${String(x.n).padStart(6)}  ${x.t}`));
    const emptyCount = wipeCounts.length - nonEmpty.length;
    console.log(`  (+ ${emptyCount} already-empty tables)`);
    console.log(`\n  TOTAL ROWS TO DELETE: ${wipeCounts.reduce((s, x) => s + x.n, 0)}`);
    console.log(`  UNTOUCHED: ${[...UNTOUCHED].join(", ")}`);

    // ─── FK pre-flight ───────────────────────────────────────────────────────
    // Runs in BOTH modes: a dry-run that skipped this would report "all clear"
    // for a commit that is guaranteed to roll back.
    const { nullify, blockers } = await preflightFkHazards({ q, preserve });

    console.log(`\n=== FK PRE-FLIGHT ===`);
    if (!Object.keys(nullify).length && !blockers.length) {
      console.log("  clean — every preserved FK points at a row that survives");
    }
    for (const [table, cols] of Object.entries(nullify)) {
      for (const c of cols) {
        console.log(`  NULL OUT  ${table}.${c.col} -> ${c.parent}  (${c.n} row(s); column is nullable)`);
      }
    }
    if (blockers.length) {
      console.error(`\n  BLOCKERS — these cannot be repaired automatically:`);
      blockers.forEach((b) => console.error(`   - ${b}`));
      console.error(`\nABORTED before any write. Fix PRESERVE and re-run.`);
      process.exitCode = 1;
      return;
    }

    if (dry) {
      console.log("\nDRY-RUN complete — nothing was written. Re-run with --commit to apply.");
      return;
    }

    // ─── Destructive path, single transaction ────────────────────────────────
    console.log("\nApplying (single transaction)...");
    await q("BEGIN");
    try {
      // 1. Save
      const saved = {};
      for (const t of preserve) {
        const filter = SAVE_FILTER[t] ? ` WHERE ${SAVE_FILTER[t]}` : "";
        await q(`CREATE TEMP TABLE "_save_${t}" ON COMMIT DROP AS SELECT * FROM "${t}"${filter}`);
        // Sever FKs into rows that will not survive the wipe (pre-flight proved
        // each of these columns is nullable). Without this the final INSERT
        // violates the FK and the whole transaction rolls back.
        for (const c of nullify[t] || []) {
          await q(`UPDATE "_save_${t}" SET "${c.col}" = NULL WHERE "${c.col}" IS NOT NULL`);
          console.log(`  nulled ${t}.${c.col} on ${c.n} saved row(s) (parent ${c.parent} is wiped)`);
        }
        saved[t] = (await q(`SELECT count(*)::int AS n FROM "_save_${t}"`)).rows[0].n;
      }
      console.log(`  saved ${Object.values(saved).reduce((a, b) => a + b, 0)} settings rows`);

      // 2. Truncate everything in one atomic statement (no FK ordering needed)
      const list = allTables
        .filter((t) => !UNTOUCHED.has(t))
        .map((t) => `public."${t}"`)
        .join(", ");
      await q(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      console.log(`  truncated ${allTables.length - UNTOUCHED.size} tables`);

      // 3. Restore in FK order (PRESERVE is already ordered parents-first)
      for (const t of preserve) {
        await q(`INSERT INTO "${t}" SELECT * FROM "_save_${t}"`);
      }
      console.log(`  restored ${preserve.length} settings tables`);

      // 4. Verify — any failure throws and rolls the whole thing back
      const problems = [];
      for (const t of preserve) {
        const n = await count(t);
        if (n !== saved[t]) problems.push(`${t}: restored ${n}, expected ${saved[t]}`);
      }
      for (const t of MUST_BE_EMPTY) {
        if (!present.has(t)) continue;
        const n = await count(t);
        if (n !== 0) problems.push(`${t}: expected empty, has ${n}`);
      }
      const ops = (await q(`SELECT count(*)::int AS n FROM "User" WHERE "userType"='operator'`)).rows[0].n;
      const nonOps = (await q(`SELECT count(*)::int AS n FROM "User" WHERE "userType"<>'operator'`)).rows[0].n;
      if (nonOps !== 0) problems.push(`User: ${nonOps} non-operator users survived`);
      if (ops === 0) problems.push(`User: no operator users survived — ${envLabel} would have no login`);

      if (problems.length) {
        throw new Error("VERIFY FAILED:\n  - " + problems.join("\n  - "));
      }

      await q("COMMIT");
      console.log(`  verified: ${ops} operator login(s), all registers empty`);
      console.log(`\nCOMMITTED. ${envLabel} database is clean.`);
    } catch (err) {
      await q("ROLLBACK");
      console.error("\nROLLED BACK — no changes applied.");
      console.error(err.message);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

/** Shared `--dry-run` / `--commit` argument parsing. */
export function parseMode(argv) {
  const dry = argv.includes("--dry-run");
  const commit = argv.includes("--commit");
  if (dry === commit) {
    console.error("Pass exactly one of --dry-run or --commit.");
    process.exit(2);
  }
  return { dry };
}
