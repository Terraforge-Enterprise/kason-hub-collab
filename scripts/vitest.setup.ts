/**
 * vitest.setup.ts
 *
 * Pre-loads the pgsql-parser WASM module before any test runs.
 * Required because parseSync() throws if WASM is not initialized.
 */
import { beforeAll } from "vitest";

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parser = require("pgsql-parser");
  await parser.loadModule();
});
