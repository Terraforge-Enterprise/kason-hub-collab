import { getDb } from "@kason/db";

export async function findActiveUserByEmail(email: string) {
  const db = getDb();
  return db.user.findFirst({
    where: {
      email,
      status: "active",
      organization: { status: "active" },
    },
    select: {
      id: true,
      organizationId: true,
      role: true,
      permissionOverrides: true,
      userType: true,
      partyId: true,
      passwordHash: true,
      fullName: true,
      email: true,
    },
  });
}
