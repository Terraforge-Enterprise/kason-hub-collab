import { describe, expect, it } from "vitest";
import { Prisma } from "@kason/db";
import { withStaleCheck } from "../optimistic-update";

describe("withStaleCheck", () => {
  it("passes through the update result", async () => {
    await expect(withStaleCheck(async () => ({ updatedAt: new Date(0) })))
      .resolves.toEqual({ updatedAt: new Date(0) });
  });

  it("maps P2025 (zero rows matched WHERE id+updatedAt) to null", async () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError("no rows", {
      code: "P2025",
      clientVersion: "test",
    });
    await expect(withStaleCheck(async () => { throw p2025; })).resolves.toBeNull();
  });

  it("rethrows everything else", async () => {
    await expect(withStaleCheck(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
