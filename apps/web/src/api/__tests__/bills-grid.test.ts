// apps/web/src/api/__tests__/bills-grid.test.ts
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  fetchGrid,
  fetchBillingFundsSummary,
  uploadAttachments,
  uploadLineAttachments,
  listLineAttachments,
  FlagDarkError,
  GRID_QUERY_KEY_ROOT,
} from "../bills-grid";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("bills-grid api client", () => {
  it("sends the funds-summary period as a full first-of-month date", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tenantDue: "0.00", tenantOutstanding: "0.00", tenantCollected: "0.00",
      depositsHeld: "0.00", ownerExpenses: "0.00", managementFee: "0.00",
      ownerPayout: "0.00", ownerPaid: "0.00", status: "safe",
    }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await fetchBillingFundsSummary("2026-08-01");
    expect(String(spy.mock.calls[0][0])).toContain("period=2026-08-01");
  });

  it("parses a 200 grid payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      period: "2026-07-01", periods: ["2026-07-01"],
      rows: [{
        apartmentId: "a1", unitCode: "PV9 A-13-13", propertyId: "p1", entry: null,
        bearerConfig: {
          tnbPattern: "recharged", airPattern: "recharged",
          cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
          cleaningRecurringAmount: "100.00", isLocked: false,
        },
        subRows: [], expenses: { tenant: { total: "0.00", withSstTotal: "0.00" }, owner: { total: "35.50", withSstTotal: "20.00" } },
        attachments: [], preview: null, previewError: null, priorMonths: [],
      }],
    }), { status: 200 })));
    const g = await fetchGrid({ months: 1 });
    expect(g.rows[0].unitCode).toBe("PV9 A-13-13");
    expect(g.rows[0].priorMonths).toEqual([]);
    expect(g.rows[0].propertyId).toBe("p1");
    expect(g.rows[0].entry).toBeNull();
    expect(g.rows[0].bearerConfig.cleaningRecurringAmount).toBe("100.00");
    expect(g.rows[0].expenses.tenant.total).toBe("0.00");
    expect(g.rows[0].expenses.owner.withSstTotal).toBe("20.00");
    expect(g.rows[0].attachments).toEqual([]);
  });

  it("throws FlagDarkError on the canonical 404, not a parse error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    await expect(fetchGrid({ months: 1 })).rejects.toBeInstanceOf(FlagDarkError);
  });

  it("attaches the admin bearer to the raw-fetch FormData upload (UAT 401 trap)", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 201 }));
    vi.stubGlobal("fetch", spy);
    localStorage.setItem("kh_token", "tok-123");
    await uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")]);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-123");
  });

  it("omits Authorization entirely when there is no admin token (never `Bearer null`)", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 201 }));
    vi.stubGlobal("fetch", spy);
    await uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")]);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("sends credentials: include on the upload request (cookie stays the desktop primary)", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 201 }));
    vi.stubGlobal("fetch", spy);
    await uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")]);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
  });

  it("builds the upload URL from API_BASE, not a hand-built origin", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 201 }));
    vi.stubGlobal("fetch", spy);
    await uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")]);
    const url = spy.mock.calls[0][0] as string;
    expect(url.endsWith("/bills-grid/apartments/a1/attachments?period=2026-07-01")).toBe(true);
  });

  it("resolves the real {data: [{id, storageKey}]} upload shape, not {id, filename, createdAt}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "att1", storageKey: "bills-grid/org1/entry1/x-a.pdf" }] }), {
          status: 201,
        }),
      ),
    );
    const result = await uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")]);
    expect(result.data).toEqual([{ id: "att1", storageKey: "bills-grid/org1/entry1/x-a.pdf" }]);
  });

  it("throws FlagDarkError on the canonical flag-dark 404 body during upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })),
    );
    await expect(uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")])).rejects.toBeInstanceOf(
      FlagDarkError,
    );
  });

  it("does NOT treat a route-specific 404 (APARTMENT_NOT_FOUND) as flag-dark during upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "APARTMENT_NOT_FOUND" }), { status: 404 })),
    );
    await expect(uploadAttachments("a1", "2026-07-01", [new File(["x"], "a.pdf")])).rejects.not.toBeInstanceOf(
      FlagDarkError,
    );
  });

  it("GRID_QUERY_KEY_ROOT is the grid root key", () => {
    expect(GRID_QUERY_KEY_ROOT).toEqual(["bills-grid", "grid"]);
  });
});

describe("per-line attachment client fns (T1 Task 4)", () => {
  it("posts multipart files to the per-line URL with no period query (B1)", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "att1", storageKey: "k" }] }), { status: 201 }));
    vi.stubGlobal("fetch", spy);
    const file = new File(["x"], "receipt.pdf");
    await uploadLineAttachments("exp-1", [file]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/bills-grid/expenses/exp-1/attachments")).toBe(true);
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.getAll("files")).toEqual([file]);
  });

  it("fetches the per-line list URL with no query string (B7)", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await listLineAttachments("exp-1");
    const url = spy.mock.calls[0][0] as string;
    expect(url.endsWith("/bills-grid/expenses/exp-1/attachments")).toBe(true);
    expect(url.includes("?")).toBe(false);
  });

  it("attaches the admin bearer to the per-line upload when present, never `Bearer null` when absent (B2)", async () => {
    const spy = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 201 })));
    vi.stubGlobal("fetch", spy);
    localStorage.setItem("kh_token", "tok-456");
    await uploadLineAttachments("exp-1", [new File(["x"], "a.pdf")]);
    const init1 = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init1.headers).get("Authorization")).toBe("Bearer tok-456");

    localStorage.clear();
    await uploadLineAttachments("exp-1", [new File(["x"], "a.pdf")]);
    const init2 = spy.mock.calls[1][1] as RequestInit;
    expect(new Headers(init2.headers).has("Authorization")).toBe(false);
  });

  it("sends credentials: include on the per-line upload (B3)", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 201 }));
    vi.stubGlobal("fetch", spy);
    await uploadLineAttachments("exp-1", [new File(["x"], "a.pdf")]);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
  });

  it("throws FlagDarkError on the canonical flag-dark 404 body during per-line upload (B4)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    await expect(uploadLineAttachments("exp-1", [new File(["x"], "a.pdf")])).rejects.toBeInstanceOf(FlagDarkError);
  });

  it("does NOT treat a route-specific 404 (EXPENSE_NOT_FOUND) as flag-dark during per-line upload (B5)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "EXPENSE_NOT_FOUND" }), { status: 404 })));
    await expect(uploadLineAttachments("exp-1", [new File(["x"], "a.pdf")])).rejects.not.toBeInstanceOf(FlagDarkError);
  });

  it("throws on a non-2xx response — no silent success (B6)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "ATTACHMENT_UPLOAD_FAILED" }), { status: 502 })));
    await expect(uploadLineAttachments("exp-1", [new File(["x"], "a.pdf")])).rejects.toThrow();
  });
});
