import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  const { getPublicCardByToken } = await import("../src/modules/public-card/service");
  const result = await getPublicCardByToken("gC8e1OWoP-zuO47hrZWjHA");
  console.log("result:", result);
}

main().catch((e) => {
  console.error("error:", e);
  process.exit(1);
});
