import { describe, it, expect } from "vitest";
import { previewFirstMonthRent } from "../rent-preview";

describe("previewFirstMonthRent", () => {
  it("prorates a mid-month move-in", () => {
    const r = previewFirstMonthRent({
      monthlyRent: 3000,
      startDate: new Date("2026-07-15T00:00:00Z"),
      endDate: null,
      rentInvoiceStartDate: null,
    });
    expect(r.month).toBe("2026-07");
    expect(r.occupiedDays).toBe(17);
    expect(r.daysInMonth).toBe(31);
    expect(r.amount).toBe(1645.16);
    expect(r.isProrated).toBe(true);
  });

  it("full month is not prorated", () => {
    const r = previewFirstMonthRent({
      monthlyRent: 3000,
      startDate: new Date("2026-07-01T00:00:00Z"),
      endDate: null,
      rentInvoiceStartDate: null,
    });
    expect(r.amount).toBe(3000);
    expect(r.isProrated).toBe(false);
  });

  // Poster-faithfulness: resolveMonthlyRentAmount -> computeProratedRent prorates
  // from tenancy.startDate and NEVER reads rentInvoiceStartDate (grep: zero
  // consumers in apps/api/src/modules/billing). The preview must therefore NOT
  // promise a month/amount the cron will not bill -- supplying rentInvoiceStartDate
  // leaves the preview on the prorated move-in month, matching exactly what the
  // auto-draft cron will post. (The "Start Rental Invoice on" shift returns only
  // once a future task teaches the poster to honour rentInvoiceStartDate too.)
  it("mirrors the poster: rentInvoiceStartDate does NOT shift the previewed month or amount", () => {
    const r = previewFirstMonthRent({
      monthlyRent: 3000,
      startDate: new Date("2026-07-15T00:00:00Z"),
      endDate: null,
      rentInvoiceStartDate: new Date("2026-08-01T00:00:00Z"),
    });
    expect(r.month).toBe("2026-07");
    expect(r.amount).toBe(1645.16);
    expect(r.isProrated).toBe(true);
  });

  it("never returns a negative amount", () => {
    const r = previewFirstMonthRent({
      monthlyRent: 3000,
      startDate: new Date("2026-07-20T00:00:00Z"),
      endDate: new Date("2026-07-10T00:00:00Z"),
      rentInvoiceStartDate: null,
    });
    expect(r.amount).toBe(0);
    expect(r.occupiedDays).toBe(0);
  });
});
