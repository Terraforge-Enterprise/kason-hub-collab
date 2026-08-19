import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import {
  getUtilityBillingConfigService,
  upsertUtilityBillingConfigService,
} from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c3000000-0000-4000-8000-000000000001";
const USER = "c3000000-0000-4000-8000-000000000002";
const sess = { orgId: ORG, userId: USER, role: "admin", userType: "operator" };

async function cleanup() {
  const db = getDb();
  await db.utilityBillingConfig.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "ConfigOrg",
      slug: "configorg",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // AuditLog.actorUserId FK → User.id (onDelete: Restrict): acting user must exist.
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "configorg@example.test",
      fullName: "Config Operator",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
}

dn("UtilityBillingConfig service (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it("get returns default subsidyPerPax '50.00' when no config row exists", async () => {
    const result = await getUtilityBillingConfigService(sess);
    expect(result.subsidyPerPax).toBe("50.00");
  });

  it("upsert creates a row and get returns the updated value", async () => {
    await upsertUtilityBillingConfigService(sess, { subsidyPerPax: "75.00" });
    const result = await getUtilityBillingConfigService(sess);
    expect(result.subsidyPerPax).toBe("75.00");
  });

  it("upsert is idempotent (singleton): second upsert overwrites first, only one row exists", async () => {
    await upsertUtilityBillingConfigService(sess, { subsidyPerPax: "75.00" });
    await upsertUtilityBillingConfigService(sess, { subsidyPerPax: "100.00" });

    const result = await getUtilityBillingConfigService(sess);
    expect(result.subsidyPerPax).toBe("100.00");

    const db = getDb();
    const count = await db.utilityBillingConfig.count({ where: { organizationId: ORG } });
    expect(count).toBe(1);
  });

  it("upsert writes an audit log row for meter.config.update", async () => {
    await upsertUtilityBillingConfigService(sess, { subsidyPerPax: "75.00" });

    const db = getDb();
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "meter.config.update" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(USER);
  });
});
