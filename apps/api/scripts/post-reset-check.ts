import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  const { db } = await import("@kason/db");

  const [orgs, props, apts, listings, submissions, propSubs] = await Promise.all([
    db.organization.count(),
    db.property.count(),
    db.apartment.count(),
    db.listing.count(),
    db.unitSubmission.count(),
    db.propertySubmission.count(),
  ]);

  console.log("Post-reset state:");
  console.log({
    organizations: orgs,
    properties: props,
    apartments: apts,
    listings,
    unitSubmissions: submissions,
    propertySubmissions: propSubs,
  });

  // Check for any AGENT_SOURCED-equivalent leftovers
  const agentSourcedListings = await db.listing.count({
    where: { sourcingAgentId: { not: null } },
  });
  console.log({ agentSourcedListings });

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
