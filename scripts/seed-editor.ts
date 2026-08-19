// One-off: add an "editor" admin user to whichever DB DATABASE_URL points at.
// Editor is the most-restricted admin tier — cannot see commission amounts,
// cannot approve claims, cannot delete listings (per apps/api/src/lib/rbac.ts).
//
// Usage:
//   npx tsx scripts/seed-editor.ts                  # local DB
//   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx scripts/seed-editor.ts

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const EDITOR_EMAIL = "editor@kaenproperties.com";
const EDITOR_PASSWORD = "editor123";
const EDITOR_FULL_NAME = "Kaen Editor";
const EDITOR_PHONE = "+60100000003";

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`scrypt:${salt}:${key.toString("hex")}`);
    });
  });
}

async function main() {
  const url = process.env.DATABASE_URL!
    .replace(/([?&])sslmode=[^&]*&?/g, "$1")
    .replace(/[?&]$/, "");
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  const adapter = new PrismaPg({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });

  // Reuse whichever org the existing admin lives in so the editor sees the
  // same data set. Safer than guessing/hardcoding an org id.
  const anchor = await prisma.user.findFirst({
    where: { role: "admin" },
    select: { organizationId: true },
  });
  if (!anchor) {
    throw new Error(
      "No admin user found — run the full seed first (`npx prisma db seed`).",
    );
  }
  const organizationId = anchor.organizationId;
  console.log(`Anchoring editor to organizationId=${organizationId}`);

  const existing = await prisma.user.findUnique({
    where: { organizationId_email: { organizationId, email: EDITOR_EMAIL } },
    select: { id: true, role: true },
  });

  const passwordHash = await hashPassword(EDITOR_PASSWORD);

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: "editor",
        passwordHash,
        status: "active",
        emailVerified: true,
        organizationId,
      },
    });
    await prisma.roleAssignment.deleteMany({
      where: { userId: existing.id, scopeType: "organization" },
    });
    await prisma.roleAssignment.create({
      data: {
        id: crypto.randomUUID(),
        organizationId,
        userId: existing.id,
        role: "editor",
        scopeType: "organization",
      },
    });
    console.log(`Updated existing user ${EDITOR_EMAIL} → role=editor`);
  } else {
    const userId = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        organizationId,
        email: EDITOR_EMAIL,
        phone: EDITOR_PHONE,
        fullName: EDITOR_FULL_NAME,
        passwordHash,
        status: "active",
        role: "editor",
        userType: "operator",
        emailVerified: true,
      },
    });
    await prisma.roleAssignment.create({
      data: {
        id: crypto.randomUUID(),
        organizationId,
        userId,
        role: "editor",
        scopeType: "organization",
      },
    });
    console.log(`Created ${EDITOR_EMAIL} (id=${userId}) → role=editor`);
  }

  console.log("");
  console.log("Login with:");
  console.log(`  email:    ${EDITOR_EMAIL}`);
  console.log(`  password: ${EDITOR_PASSWORD}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
