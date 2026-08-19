import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@kason/db", () => {
  const findFirst = vi.fn();
  return { getDb: () => ({ payment: { findFirst } }), __findFirst: findFirst };
});
vi.mock("../../../lib/storage", () => ({ createSignedDownloadUrl: vi.fn() }));

import { getPaymentProofUrlsService } from "../payments.proof-urls";
import { createSignedDownloadUrl } from "../../../lib/storage";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbMock: any = await import("@kason/db");
const findFirst = dbMock.__findFirst as ReturnType<typeof vi.fn>;

beforeEach(() => { findFirst.mockReset(); (createSignedDownloadUrl as ReturnType<typeof vi.fn>).mockReset(); });

describe("getPaymentProofUrlsService", () => {
  it("returns a signed URL per attachment key", async () => {
    findFirst.mockResolvedValue({ id: "p1", attachmentKeys: ["k/a.jpg", "k/b.jpg"] });
    (createSignedDownloadUrl as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) => `signed:${k}`);
    const res = await getPaymentProofUrlsService("org", "p1");
    expect(res).toEqual({ ok: true, urls: ["signed:k/a.jpg", "signed:k/b.jpg"] });
  });

  it("returns empty urls for a payment with no keys", async () => {
    findFirst.mockResolvedValue({ id: "p1", attachmentKeys: [] });
    const res = await getPaymentProofUrlsService("org", "p1");
    expect(res).toEqual({ ok: true, urls: [] });
  });

  it("404 when the payment is missing/cross-org", async () => {
    findFirst.mockResolvedValue(null);
    const res = await getPaymentProofUrlsService("org", "nope");
    expect(res).toEqual({ ok: false, status: 404 });
  });

  it("502 when signing throws", async () => {
    findFirst.mockResolvedValue({ id: "p1", attachmentKeys: ["k/a.jpg"] });
    (createSignedDownloadUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("supabase down"));
    const res = await getPaymentProofUrlsService("org", "p1");
    expect(res).toEqual({ ok: false, status: 502 });
  });
});
