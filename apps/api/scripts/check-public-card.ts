import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  const { db } = await import("@kason/db");
  const token = "gC8e1OWoP-zuO47hrZWjHA";

  const version = await db.agentCardVersion.findFirst({
    where: { publicToken: token },
    include: {
      party: {
        include: {
          organization: { include: { cardSettings: true } },
        },
      },
    },
  });

  if (!version) {
    console.log("No AgentCardVersion with that token");
    await db.$disconnect();
    return;
  }

  console.log("version:", {
    id: version.id,
    status: version.status,
    expiresAt: version.expiresAt,
    nowGt: version.expiresAt > new Date(),
  });
  console.log("party:", {
    id: version.party.id,
    status: version.party.status,
    organizationId: version.party.organizationId,
  });
  console.log("org:", {
    id: version.party.organization.id,
    status: version.party.organization.status,
  });
  console.log("cardSettings exists?", !!version.party.organization.cardSettings);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
