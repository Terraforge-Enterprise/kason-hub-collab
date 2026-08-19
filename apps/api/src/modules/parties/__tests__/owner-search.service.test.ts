import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../parties.repository", () => ({ searchOwners: vi.fn() }));
import { searchOwners } from "../parties.repository";
import { searchOwnersService } from "../parties.service";

const session = { orgId: "o1" } as any;

beforeEach(() => vi.clearAllMocks());

describe("searchOwnersService", () => {
  it("returns slim shape (no idNumber/bank) and formats phone", async () => {
    vi.mocked(searchOwners).mockResolvedValueOnce([
      { id: "own1", displayName: "RAZIF RAZALI", primaryPhone: "60123456789" },
    ]);
    const { data } = await searchOwnersService(session, "raz", 20);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "own1",
      displayName: "RAZIF RAZALI",
      primaryPhone: "60123456789",
    });
    expect(data[0]!.formattedPhone).toContain("12");
    // PII hard guarantee: no IC / bank / blacklist fields
    const serialised = JSON.stringify(data[0]);
    expect(serialised).not.toContain("idNumber");
    expect(serialised).not.toContain("idNumberMasked");
    expect(serialised).not.toContain("bank");
    expect("idNumber" in (data[0] as object)).toBe(false);
  });

  it("nulls formattedPhone when primaryPhone is null", async () => {
    vi.mocked(searchOwners).mockResolvedValueOnce([
      { id: "own2", displayName: "NO PHONE", primaryPhone: null },
    ]);
    const { data } = await searchOwnersService(session, "no", 20);
    expect(data[0]).toMatchObject({ primaryPhone: null, formattedPhone: null });
  });

  it("passes q + clamped take through to the repo", async () => {
    vi.mocked(searchOwners).mockResolvedValueOnce([]);
    await searchOwnersService(session, "ali", 999);
    expect(searchOwners).toHaveBeenCalledWith("o1", "ali", 20); // clamped to 20
  });

  it("filters only owner-role parties (repo enforces; service passes orgId)", async () => {
    vi.mocked(searchOwners).mockResolvedValueOnce([]);
    await searchOwnersService(session, undefined, 5);
    expect(searchOwners).toHaveBeenCalledWith("o1", undefined, 5);
  });
});
