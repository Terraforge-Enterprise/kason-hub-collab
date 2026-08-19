import { describe, it, expect, vi } from "vitest";

vi.mock("../audit.service", () => ({
  purgeExpiredAudit: vi.fn(async () => ({ count: 7 })),
}));

import { runAuditPurge } from "../audit-purge.job";
import { purgeExpiredAudit } from "../audit.service";

describe("runAuditPurge", () => {
  it("calls purgeExpiredAudit with default 10-day retention and returns count", async () => {
    const n = await runAuditPurge();
    expect(purgeExpiredAudit).toHaveBeenCalledWith(10);
    expect(n).toBe(7);
  });
});
