import { describe, it, expect } from "vitest";
import { extractMigrationFacts } from "./regen-schema-changelog";

describe("extractMigrationFacts", () => {
  it("captures CREATE TABLE with columns", () => {
    const sql = `
      CREATE TABLE "Tenant" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
      );
    `;
    const facts = extractMigrationFacts(sql);
    expect(facts.tablesCreated).toContain("Tenant");
    expect(facts.destructive).toBe(false);
    expect(facts.parseError).toBe(false);
  });

  it("flags DROP COLUMN as destructive", () => {
    const sql = `ALTER TABLE "Tenant" DROP COLUMN "legacyField";`;
    const facts = extractMigrationFacts(sql);
    expect(facts.columnsDropped).toEqual([
      { table: "Tenant", column: "legacyField" },
    ]);
    expect(facts.destructive).toBe(true);
  });

  it("flags ADD COLUMN with NOT NULL no DEFAULT as destructive", () => {
    const sql = `ALTER TABLE "Tenant" ADD COLUMN "required" TEXT NOT NULL;`;
    const facts = extractMigrationFacts(sql);
    expect(facts.destructive).toBe(true);
  });

  it("does NOT flag ADD COLUMN with DEFAULT as destructive", () => {
    const sql = `ALTER TABLE "Tenant" ADD COLUMN "optional" TEXT NOT NULL DEFAULT 'x';`;
    const facts = extractMigrationFacts(sql);
    expect(facts.destructive).toBe(false);
    expect(facts.columnsAdded.length).toBe(1);
    expect(facts.columnsAdded[0].column).toBe("optional");
  });

  it("returns parseError=true on unparseable SQL", () => {
    const sql = `THIS IS NOT VALID SQL %%%`;
    const facts = extractMigrationFacts(sql);
    expect(facts.parseError).toBe(true);
    expect(facts.destructive).toBe(true); // fail-closed: unknown is treated destructive
  });
});
