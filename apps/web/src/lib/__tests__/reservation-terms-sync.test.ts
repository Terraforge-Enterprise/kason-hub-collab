import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TERMS_AND_CONDITIONS as CLIENT_TERMS } from "../reservation-terms";

describe("reservation TERMS_AND_CONDITIONS sync", () => {
  it("client array matches the server array byte-for-byte", () => {
    // Read the server's render-body.ts and extract the TERMS_AND_CONDITIONS literal.
    // We deliberately read the file rather than importing — the server module pulls
    // in heavyweight transitive deps that vitest's web config can't resolve.
    //
    // Path segments: __tests__ → lib (1) → src (2) → apps/web (3) → apps (4) → repo root (5)
    // then down to apps/api/src/modules/reservations/render-body.ts
    const serverPath = path.join(
      __dirname,
      "../../../../../apps/api/src/modules/reservations/render-body.ts",
    );
    const serverSrc = fs.readFileSync(serverPath, "utf-8");
    const match = serverSrc.match(
      /export const TERMS_AND_CONDITIONS: string\[\]\s*=\s*\[([\s\S]*?)\];/m,
    );
    expect(match, "could not locate TERMS_AND_CONDITIONS in render-body.ts").toBeTruthy();
    const serverLiteral = match![1];
    // Extract each "..." string literal in order.
    const serverArr = [...serverLiteral.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    );
    expect(serverArr).toEqual([...CLIENT_TERMS]);
    expect(serverArr).toHaveLength(11);
  });
});
