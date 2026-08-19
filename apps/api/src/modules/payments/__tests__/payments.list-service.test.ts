/**
 * payments.list-service.test.ts
 * Service-level tests for getPaymentsService (B6): opts pass-through to listPayments.
 * Separate from payments.list.test.ts to avoid conflict with that file's
 * top-level vi.mock("../payments.service").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as repo from "../payments.repository";

// Mock only listPayments on the repository; leave everything else real.
vi.mock("../payments.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../payments.repository")>();
  return {
    ...actual,
    listPayments: vi.fn(),
  };
});

// Import the real (unmocked) service after vi.mock is hoisted.
import { getPaymentsService } from "../payments.service";

const session = { userId: "u1", orgId: "org1", role: "editor" } as never;

describe("getPaymentsService — opts pass-through to listPayments", () => {
  beforeEach(() => {
    vi.mocked(repo.listPayments).mockReset();
  });

  it("forwards all opts to listPayments and returns result", async () => {
    const listResult = { data: [{ id: "p1", status: "posted" }], nextCursor: "cursor-value" };
    vi.mocked(repo.listPayments).mockResolvedValueOnce(listResult as never);

    const opts = { status: "posted", limit: 10 };
    const result = await getPaymentsService(session, opts);

    expect(repo.listPayments).toHaveBeenCalledWith("org1", opts);
    expect(result).toEqual(listResult);
  });

  it("works with no opts (backward compat) — result has {data, nextCursor}", async () => {
    const listResult = { data: [], nextCursor: null };
    vi.mocked(repo.listPayments).mockResolvedValueOnce(listResult as never);

    const result = await getPaymentsService(session);

    expect(repo.listPayments).toHaveBeenCalledWith("org1", undefined);
    expect(result).toEqual(listResult);
    expect(Array.isArray((result as { data: unknown[] }).data)).toBe(true);
  });
});
