import { describe, it, expect } from "vitest";
import {
  findTablesMissingRls,
  type Migration,
} from "./check-new-tables-have-rls";

describe("findTablesMissingRls", () => {
  it("flags a CREATE TABLE without ENABLE ROW LEVEL SECURITY", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_add_widgets",
        sql: `CREATE TABLE "Widget" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Widget_pkey" PRIMARY KEY ("id")
);`,
      },
    ];
    expect(findTablesMissingRls(migrations)).toEqual([
      { migration: "20260601000000_add_widgets", table: "Widget" },
    ]);
  });

  it("passes when CREATE TABLE is paired with ENABLE ROW LEVEL SECURITY", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_add_widgets",
        sql: `CREATE TABLE "Widget" (
  "id" TEXT NOT NULL,
  CONSTRAINT "Widget_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Widget" ENABLE ROW LEVEL SECURITY;`,
      },
    ];
    expect(findTablesMissingRls(migrations)).toEqual([]);
  });

  it("treats the bootstrap RLS-lockdown migration as covering all tables", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_add_widgets",
        sql: `CREATE TABLE "Widget" ("id" TEXT);`,
      },
      {
        name: "20260506000000_rls_lockdown_deny_all",
        sql: `DO $$ BEGIN ... ENABLE ROW LEVEL SECURITY ... END; $$;`,
      },
    ];
    // The bootstrap migration runs before the widget migration in time order
    // (20260506 < 20260601). Any CREATE TABLE AFTER the bootstrap must enable
    // RLS itself — the bootstrap doesn't reach back in time.
    expect(findTablesMissingRls(migrations)).toEqual([
      { migration: "20260601000000_add_widgets", table: "Widget" },
    ]);
  });

  it("treats CREATE TABLE BEFORE the bootstrap as covered (because bootstrap loops)", () => {
    const migrations: Migration[] = [
      {
        name: "20260101000000_initial",
        sql: `CREATE TABLE "User" ("id" TEXT);`,
      },
      {
        name: "20260506000000_rls_lockdown_deny_all",
        sql: `DO $$ BEGIN ... ENABLE ROW LEVEL SECURITY ... END; $$;`,
      },
    ];
    expect(findTablesMissingRls(migrations)).toEqual([]);
  });

  it("handles multiple CREATE TABLE statements in one migration", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_pair",
        sql: `CREATE TABLE "Widget" ("id" TEXT);
CREATE TABLE "Gadget" ("id" TEXT);
ALTER TABLE "Widget" ENABLE ROW LEVEL SECURITY;`,
      },
    ];
    expect(findTablesMissingRls(migrations)).toEqual([
      { migration: "20260601000000_pair", table: "Gadget" },
    ]);
  });

  it("ignores CREATE TABLE IF NOT EXISTS variants but still requires RLS", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_add_thing",
        sql: `CREATE TABLE IF NOT EXISTS "Thing" ("id" TEXT);`,
      },
    ];
    expect(findTablesMissingRls(migrations)).toEqual([
      { migration: "20260601000000_add_thing", table: "Thing" },
    ]);
  });

  it("ignores CREATE TABLE inside line comments", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_commented",
        sql: `-- CREATE TABLE "Ghost" ("id" TEXT);
CREATE TABLE "Real" ("id" TEXT);
ALTER TABLE "Real" ENABLE ROW LEVEL SECURITY;`,
      },
    ];
    // The commented-out Ghost should not be flagged. Real is paired, so no issues.
    expect(findTablesMissingRls(migrations)).toEqual([]);
  });

  it("does not let a commented-out ENABLE ROW LEVEL SECURITY satisfy the lint", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_fakeout",
        sql: `CREATE TABLE "Real" ("id" TEXT);
-- ALTER TABLE "Real" ENABLE ROW LEVEL SECURITY;`,
      },
    ];
    // Without comment-stripping, this would falsely pass. With it, "Real" is flagged.
    expect(findTablesMissingRls(migrations)).toEqual([
      { migration: "20260601000000_fakeout", table: "Real" },
    ]);
  });

  it("ignores CREATE TABLE inside block comments", () => {
    const migrations: Migration[] = [
      {
        name: "20260601000000_block_commented",
        sql: `/* CREATE TABLE "Ghost" ("id" TEXT); */
CREATE TABLE "Real" ("id" TEXT);
ALTER TABLE "Real" ENABLE ROW LEVEL SECURITY;`,
      },
    ];
    expect(findTablesMissingRls(migrations)).toEqual([]);
  });
});
