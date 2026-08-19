import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory org record for the mock.
let orgRow: {
  id: string;
  name: string;
  ownerStatementSendDay: number;
  ownerStatementSendHour: number;
  timezone: string;
} | null = null;

vi.mock("@kason/db", () => {
  const tx = {
    organization: {
      findUniqueOrThrow: vi.fn(async () => {
        if (!orgRow) throw new Error("Organization not found");
        return { ...orgRow };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (!orgRow) throw new Error("Organization not found");
        orgRow = { ...orgRow, ...args.data };
        return { ...orgRow };
      }),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
    },
  };
  const mockDb = {
    organization: tx.organization,
    auditLog: tx.auditLog,
    $transaction: vi.fn(async <T,>(callback: (t: typeof tx) => Promise<T>) => callback(tx)),
  };
  return { getDb: () => mockDb };
});

import { getDb } from "@kason/db";
import {
  getOrganizationProfileService,
  updateOrganizationProfileService,
} from "../service";

const mockDb = getDb() as unknown as {
  organization: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

function adminSession(role: string = "manager") {
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    role,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  orgRow = {
    id: ORG_ID,
    name: "Acme Properties",
    ownerStatementSendDay: 3,
    ownerStatementSendHour: 9,
    timezone: "Asia/Kuala_Lumpur",
  };
});

describe("getOrganizationProfileService", () => {
  it("returns the org's id, name and owner-statement send schedule", async () => {
    const result = await getOrganizationProfileService(adminSession());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exact shape on purpose: read and write project the same PROFILE_SELECT, so a
    // field added to one and forgotten in the other fails here.
    expect(result.data).toEqual({
      id: ORG_ID,
      name: "Acme Properties",
      ownerStatementSendDay: 3,
      ownerStatementSendHour: 9,
      timezone: "Asia/Kuala_Lumpur",
    });
  });

  it("rejects editor role with 403", async () => {
    const result = await getOrganizationProfileService(adminSession("editor"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });
});

describe("updateOrganizationProfileService", () => {
  it("updates the name and writes an AuditLog row", async () => {
    const result = await updateOrganizationProfileService(adminSession(), {
      name: "Acme Holdings",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      id: ORG_ID,
      name: "Acme Holdings",
      // Untouched by a name-only PATCH.
      ownerStatementSendDay: 3,
      ownerStatementSendHour: 9,
      timezone: "Asia/Kuala_Lumpur",
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      organizationId: ORG_ID,
      action: "organization.profile_updated",
      entityType: "Organization",
      entityId: ORG_ID,
    });
  });

  it("skips the audit row on a no-op rename (same name)", async () => {
    const result = await updateOrganizationProfileService(adminSession(), {
      name: "Acme Properties",
    });
    expect(result.ok).toBe(true);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.organization.update).not.toHaveBeenCalled();
  });

  it("rejects editor role with 403 and writes no audit", async () => {
    const result = await updateOrganizationProfileService(adminSession("editor"), {
      name: "Should Not Apply",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.organization.update).not.toHaveBeenCalled();
  });

  it("uses a single $transaction for update + audit (atomicity)", async () => {
    await updateOrganizationProfileService(adminSession(), { name: "New Name" });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ─── Owner-statement auto-send schedule ───────────────────────────────────────
// The day/hour at which the just-ended month's frozen statements are released to
// owners, read by send-owner-statements.ts in the ORG'S OWN timezone.

describe("owner-statement send schedule", () => {
  it("returns the schedule and the timezone it is interpreted in", async () => {
    const res = await getOrganizationProfileService(adminSession());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ownerStatementSendDay).toBe(3);
    expect(res.data.ownerStatementSendHour).toBe(9);
    // Returned so the UI can name the clock instead of leaving the reader to guess.
    expect(res.data.timezone).toBe("Asia/Kuala_Lumpur");
  });

  it("updates the send day and hour", async () => {
    const res = await updateOrganizationProfileService(adminSession(), {
      name: "Acme Properties",
      ownerStatementSendDay: 7,
      ownerStatementSendHour: 14,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ownerStatementSendDay).toBe(7);
    expect(res.data.ownerStatementSendHour).toBe(14);
  });

  // REGRESSION GUARD. The no-op short-circuit originally compared ONLY `name`, so a
  // schedule edit submitted without also renaming the org would have matched the
  // short-circuit and been silently discarded — the form would report success while
  // the send day never moved.
  it("persists a schedule-only edit (no name change) instead of short-circuiting", async () => {
    const res = await updateOrganizationProfileService(adminSession(), {
      name: "Acme Properties", // unchanged
      ownerStatementSendDay: 21,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mockDb.organization.update).toHaveBeenCalledTimes(1);
    expect(res.data.ownerStatementSendDay).toBe(21);
  });

  it("leaves an omitted schedule field untouched (absent ≠ reset)", async () => {
    const res = await updateOrganizationProfileService(adminSession(), {
      name: "Renamed Co",
      // no schedule fields at all — a legacy name-only PATCH
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ownerStatementSendDay).toBe(3);
    expect(res.data.ownerStatementSendHour).toBe(9);
  });

  it("still short-circuits when nothing at all changed", async () => {
    const res = await updateOrganizationProfileService(adminSession(), {
      name: "Acme Properties",
      ownerStatementSendDay: 3,
      ownerStatementSendHour: 9,
    });
    expect(res.ok).toBe(true);
    expect(mockDb.organization.update).not.toHaveBeenCalled();
  });

  it("audits the schedule change, not just the name", async () => {
    await updateOrganizationProfileService(adminSession(), {
      name: "Acme Properties",
      ownerStatementSendDay: 11,
    });
    const auditArg = mockDb.auditLog.create.mock.calls[0]?.[0] as
      | { data?: { diff?: { before?: Record<string, unknown>; after?: Record<string, unknown> } } }
      | undefined;
    const diff = auditArg?.data?.diff;
    expect(diff?.before?.ownerStatementSendDay).toBe(3);
    expect(diff?.after?.ownerStatementSendDay).toBe(11);
  });
});
