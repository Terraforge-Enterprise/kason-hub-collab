import { describe, it, expect } from "vitest";
import { parseUserAgent, primaryIp, enrichAuditRows, type RawAuditRow } from "../audit-enrich";

describe("primaryIp", () => {
  it("takes the leftmost ip of an x-forwarded-for chain", () => {
    expect(primaryIp("203.0.113.5, 70.41.3.18, 150.172.238.178")).toBe("203.0.113.5");
  });
  it("handles single, empty, and null", () => {
    expect(primaryIp("203.0.113.5")).toBe("203.0.113.5");
    expect(primaryIp("")).toBeNull();
    expect(primaryIp(null)).toBeNull();
  });
});

describe("parseUserAgent", () => {
  it("Chrome on macOS", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome · macOS");
  });
  it("Safari on iOS", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iOS");
  });
  it("null ⇒ null", () => {
    expect(parseUserAgent(null)).toBeNull();
  });
});

describe("enrichAuditRows", () => {
  const fakeDb = {
    user: { findMany: async () => [{ id: "u1", fullName: "Jane Tan" }] },
    task: { findMany: async () => [{ id: "task1", title: "Fix leaking tap" }] },
    sprint: { findMany: async () => [{ id: "sp1", name: null, seq: 3 }] },
  } as unknown as Parameters<typeof enrichAuditRows>[0];

  const rows: RawAuditRow[] = [
    { id: "a1", actorUserId: "u1", actorRole: "admin", action: "tasks.task.create", entityType: "Task", entityId: "task1", ip: "203.0.113.5, 10.0.0.1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36", createdAt: new Date("2026-06-30T03:07:00.000Z") },
    { id: "a2", actorUserId: "u1", actorRole: "admin", action: "tasks.sprint.start", entityType: "Sprint", entityId: "sp1", ip: null, userAgent: null, createdAt: new Date("2026-06-30T03:06:00.000Z") },
    { id: "a3", actorUserId: "u1", actorRole: "admin", action: "x.y", entityType: "Unknown", entityId: "z9deadbeef", ip: null, userAgent: null, createdAt: new Date("2026-06-30T03:05:00.000Z") },
  ];

  it("resolves actor + entity names, primary ip, and device", async () => {
    const out = await enrichAuditRows(fakeDb, rows);
    expect(out[0].actorName).toBe("Jane Tan");
    expect(out[0].entityName).toBe("Fix leaking tap");
    expect(out[0].ip).toBe("203.0.113.5");
    expect(out[0].deviceName).toBe("Chrome · macOS");
    expect(out[0].createdAt).toBe("2026-06-30T03:07:00.000Z");
    expect(out[1].entityName).toBe("Sprint 3"); // null name ⇒ Sprint ${seq}
    expect(out[2].entityName).toBeNull(); // unsupported type ⇒ null (frontend shows short id)
  });
});
