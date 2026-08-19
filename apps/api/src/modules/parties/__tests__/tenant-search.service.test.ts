import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../parties.repository", () => ({ searchTenants: vi.fn() }));
import { searchTenants } from "../parties.repository";
import { searchTenantsService } from "../parties.service";

const session = { orgId: "o1" } as any;

beforeEach(() => vi.clearAllMocks());

describe("searchTenantsService", () => {
  it("masks idNumber to last-4 and formats phone; never returns raw idNumber", async () => {
    vi.mocked(searchTenants).mockResolvedValueOnce([
      { id: "t1", displayName: "NURUL IZZAH", primaryPhone: "60123456789",
        idType: "nric", idNumber: "990101-14-5678" },
    ]);
    const { data } = await searchTenantsService(session, "nur", 20);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: "t1", displayName: "NURUL IZZAH",
      idType: "nric", idNumberMasked: "••••5678",
      primaryPhone: "60123456789",
    });
    expect(data[0]!.formattedPhone).toContain("12");
    // hard guarantee: the raw IC field is gone
    expect(JSON.stringify(data[0])).not.toContain("990101-14-5678");
    expect("idNumber" in (data[0] as object)).toBe(false);
  });

  it("nulls mask + phone when source fields are null", async () => {
    vi.mocked(searchTenants).mockResolvedValueOnce([
      { id: "t2", displayName: "NO IC", primaryPhone: null, idType: null, idNumber: null },
    ]);
    const { data } = await searchTenantsService(session, "no", 20);
    expect(data[0]).toMatchObject({ idNumberMasked: null, primaryPhone: null, formattedPhone: null });
  });

  it("passes q + clamped take through to the repo (name-only search)", async () => {
    vi.mocked(searchTenants).mockResolvedValueOnce([]);
    await searchTenantsService(session, "ali", 999);
    expect(searchTenants).toHaveBeenCalledWith("o1", "ali", 20); // clamped to 20
  });
});
