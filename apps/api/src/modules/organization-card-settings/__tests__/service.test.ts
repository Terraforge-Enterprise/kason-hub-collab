import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @kason/db ──────────────────────────────────────────────────────────
vi.mock("@kason/db", () => {
  const mockDb = {
    organizationCardSettings: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  };
  return { getDb: () => mockDb };
});

import { getDb } from "@kason/db";
import { getOrgCardSettings, updateOrgCardSettings } from "../service";

const mockDb = getDb() as unknown as {
  organizationCardSettings: {
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const baseSettings = {
  id: "22222222-2222-2222-2222-222222222222",
  organizationId: ORG_ID,
  agencyName: null as string | null,
  agencyLicense: null as string | null,
  agencyPhone: null as string | null,
  agencyFax: null as string | null,
  addressLine1: null as string | null,
  addressLine2: null as string | null,
  addressLine3: null as string | null,
  addressLine4: null as string | null,
  cardExpiryMonths: 3,
  isConfigured: false,
  logoKey: null as string | null,
  updatedAt: new Date("2026-05-05T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("organization-card-settings service", () => {
  describe("getOrgCardSettings", () => {
    it("returns settings with isConfigured=false initially", async () => {
      mockDb.organizationCardSettings.upsert.mockResolvedValueOnce({ ...baseSettings });

      const settings = await getOrgCardSettings(ORG_ID);

      expect(settings.isConfigured).toBe(false);
      expect(settings.agencyName).toBeNull();
      expect(mockDb.organizationCardSettings.upsert).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID },
        create: { organizationId: ORG_ID },
        update: {},
      });
    });

    it("lazy-creates the default row if no settings exist yet", async () => {
      // Prisma upsert returns the newly-created row when no existing one was found.
      mockDb.organizationCardSettings.upsert.mockResolvedValueOnce({ ...baseSettings });

      const settings = await getOrgCardSettings(ORG_ID);

      expect(settings).toEqual(baseSettings);
      expect(settings.isConfigured).toBe(false);
      // No throw — the prior behavior of "throws when missing" is replaced
      // by lazy create. Callers can rely on always receiving a row.
    });
  });

  describe("updateOrgCardSettings", () => {
    it("flips isConfigured=true when all required fields are filled", async () => {
      // First the service reads existing settings via upsert (all null)
      mockDb.organizationCardSettings.upsert.mockResolvedValueOnce({ ...baseSettings });
      // Then it updates and the DB returns the merged row
      mockDb.organizationCardSettings.update.mockImplementationOnce(async (args: any) => ({
        ...baseSettings,
        ...args.data,
      }));

      const result = await updateOrgCardSettings(ORG_ID, {
        agencyName: "EUM Realty Sdn Bhd",
        agencyLicense: "E(1) 1708",
        addressLine1: "Kaen Properties Sdn Bhd (1466670-H)",
      });

      expect(result.isConfigured).toBe(true);
      expect(result.agencyName).toBe("EUM Realty Sdn Bhd");
      expect(mockDb.organizationCardSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORG_ID },
          data: expect.objectContaining({
            agencyName: "EUM Realty Sdn Bhd",
            agencyLicense: "E(1) 1708",
            addressLine1: "Kaen Properties Sdn Bhd (1466670-H)",
            isConfigured: true,
          }),
        }),
      );
    });

    it("does NOT flip isConfigured if any required field is missing", async () => {
      mockDb.organizationCardSettings.upsert.mockResolvedValueOnce({ ...baseSettings });
      mockDb.organizationCardSettings.update.mockImplementationOnce(async (args: any) => ({
        ...baseSettings,
        ...args.data,
      }));

      const result = await updateOrgCardSettings(ORG_ID, {
        agencyLicense: "E(1) 1708",
        addressLine1: "Kaen Properties Sdn Bhd (1466670-H)",
      });

      expect(result.isConfigured).toBe(false);
      expect(mockDb.organizationCardSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isConfigured: false }),
        }),
      );
    });

    it("treats whitespace-only required fields as unset (does NOT flip isConfigured)", async () => {
      mockDb.organizationCardSettings.upsert.mockResolvedValueOnce({ ...baseSettings });
      mockDb.organizationCardSettings.update.mockImplementationOnce(async (args: any) => ({
        ...baseSettings,
        ...args.data,
      }));

      const result = await updateOrgCardSettings(ORG_ID, {
        agencyName: "   ",
        agencyLicense: "E(1) 1708",
        addressLine1: "Kaen Properties Sdn Bhd (1466670-H)",
      });

      expect(result.isConfigured).toBe(false);
    });

    it("preserves previously-saved required fields when input omits them (still flips on if merged is complete)", async () => {
      mockDb.organizationCardSettings.upsert.mockResolvedValueOnce({
        ...baseSettings,
        agencyName: "EUM Realty Sdn Bhd",
        agencyLicense: "E(1) 1708",
      });
      mockDb.organizationCardSettings.update.mockImplementationOnce(async (args: any) => ({
        ...baseSettings,
        ...args.data,
      }));

      const result = await updateOrgCardSettings(ORG_ID, {
        addressLine1: "Kaen Properties Sdn Bhd (1466670-H)",
      });

      expect(result.isConfigured).toBe(true);
    });
  });
});
