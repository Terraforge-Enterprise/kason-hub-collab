import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import crypto from "node:crypto";

const rawUrl = process.env.DATABASE_URL!;
const adapter = new PrismaPg({
  connectionString: rawUrl.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, ""),
  ssl: /localhost|127\.0\.0\.1/.test(rawUrl) ? false : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter });

function uuid() {
  return crypto.randomUUID();
}

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

async function main() {
  console.log("Seeding admin-only (organization + admin user + role assignment)...");

  const existingAdmin = await prisma.user.findFirst({
    where: { email: "admin@kaenproperties.com" },
  });
  if (existingAdmin) {
    console.log(`Admin already exists (id=${existingAdmin.id}), aborting to avoid duplicate.`);
    return;
  }

  const orgId = uuid();
  const adminUserId = uuid();

  const org = await prisma.organization.create({
    data: {
      id: orgId,
      name: "Kaen Properties Sdn Bhd",
      slug: "kaen-uat",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "starter",
      billingCycleMode: "calendar",
      billLeadDays: 30,
      tenancyExpiryReminderDays: 30,
      currencyDisplay: "symbol",
      managementFeePercent: 10,
    },
  });
  console.log(`  Org created: ${org.name} (${org.id})`);

  const adminHash = await hashPassword("admin123");
  const adminUser = await prisma.user.create({
    data: {
      id: adminUserId,
      organizationId: org.id,
      email: "admin@kaenproperties.com",
      phone: "+60123456789",
      fullName: "Kaen Admin",
      passwordHash: adminHash,
      status: "active",
      role: "admin",
      userType: "operator",
      emailVerified: true,
    },
  });
  console.log(`  Admin user created: ${adminUser.email}`);

  await prisma.roleAssignment.create({
    data: {
      id: uuid(),
      organizationId: org.id,
      userId: adminUserId,
      role: "admin",
      scopeType: "organization",
    },
  });
  console.log(`  RoleAssignment created (admin @ organization)`);

  console.log("\nLogin: admin@kaenproperties.com / admin123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
