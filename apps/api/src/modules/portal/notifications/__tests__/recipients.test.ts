import { describe, it, expect, vi } from "vitest";
import { walkUplineChain, resolveRecipients } from "../recipients";

const mkParty = (id: string, uplineId: string | null, opts: Partial<{ whatsappPhone: string | null; notifyOnNewClaim: boolean; status: string }> = {}) => ({
  id,
  uplineId,
  whatsappPhone: "whatsappPhone" in opts ? opts.whatsappPhone : `+60${id}`,
  notifyOnNewClaim: opts.notifyOnNewClaim ?? true,
  status: opts.status ?? "active",
  displayName: `Party ${id}`,
});

describe("walkUplineChain", () => {
  it("walks from filer up to root, returning ancestor ids in order", async () => {
    const tx = {
      party: {
        findUnique: vi.fn(async ({ where }: any) => {
          const map: Record<string, any> = {
            filer: { uplineId: "u1" },
            u1: { uplineId: "u2" },
            u2: { uplineId: null },
          };
          return map[where.id] ?? null;
        }),
      },
    } as any;
    const chain = await walkUplineChain("filer", tx);
    expect(chain).toEqual(["u1", "u2"]);
  });

  it("is cycle-safe — returns visited ancestors only once", async () => {
    const tx = {
      party: {
        findUnique: vi.fn(async ({ where }: any) => {
          const map: Record<string, any> = {
            filer: { uplineId: "u1" },
            u1: { uplineId: "u2" },
            u2: { uplineId: "u1" },
          };
          return map[where.id] ?? null;
        }),
      },
    } as any;
    const chain = await walkUplineChain("filer", tx);
    expect(chain).toEqual(["u1", "u2"]);
  });

  it("returns empty array if filer has no upline", async () => {
    const tx = { party: { findUnique: vi.fn(async () => ({ uplineId: null })) } } as any;
    const chain = await walkUplineChain("filer", tx);
    expect(chain).toEqual([]);
  });
});

describe("resolveRecipients", () => {
  it("unions upline chain + admin parties, dedupes, filters by phone+optin+status", async () => {
    const partyData: Record<string, any> = {
      filer: { id: "filer", uplineId: "u1" },
      u1: mkParty("u1", "u2"),
      u2: mkParty("u2", null),
      adminA: mkParty("adminA", null),
      adminB: mkParty("adminB", null, { whatsappPhone: null }),
      adminC: mkParty("adminC", null, { notifyOnNewClaim: false }),
      adminD: mkParty("adminD", null, { status: "blacklisted" }),
    };
    const tx = {
      party: {
        findUnique: vi.fn(async ({ where }: any) => partyData[where.id] ?? null),
        findMany: vi.fn(async ({ where }: any) => {
          if (where.id?.in) return where.id.in.map((id: string) => partyData[id]).filter(Boolean);
          return [];
        }),
      },
      user: {
        findMany: vi.fn(async () => [
          { partyId: "adminA" }, { partyId: "adminB" }, { partyId: "adminC" }, { partyId: "adminD" },
          { partyId: "u1" },
        ]),
      },
    } as any;
    const recipients = await resolveRecipients("filer", "org-1", tx);
    expect(recipients.map((r) => r.id).sort()).toEqual(["adminA", "u1", "u2"]);
  });

  it("skips the filer even if they're an admin", async () => {
    const partyData: Record<string, any> = { filer: mkParty("filer", null) };
    const tx = {
      party: {
        findUnique: vi.fn(async ({ where }: any) => partyData[where.id] ?? null),
        findMany: vi.fn(async ({ where }: any) =>
          where.id?.in ? where.id.in.map((id: string) => partyData[id]).filter(Boolean) : [],
        ),
      },
      user: { findMany: vi.fn(async () => [{ partyId: "filer" }]) },
    } as any;
    const recipients = await resolveRecipients("filer", "org-1", tx);
    expect(recipients).toEqual([]);
  });
});
