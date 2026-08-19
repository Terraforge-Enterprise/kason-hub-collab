/**
 * Shape-verification tests: every route that validates a body must return
 * { error, fieldErrors } (never the old `details` key) when Zod rejects the
 * input. Part of T11 — formatZodError sweep.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ReservationSession } from "../types";
import { reservationsRoutes } from "../routes";

// ── Service mocks — DB is never reached ──────────────────────────────────────
vi.mock("../service", () => ({
  createReservationService: vi.fn(),
  listReservationsForAgent: vi.fn().mockResolvedValue([]),
  listReservationsForOrg: vi.fn().mockResolvedValue([]),
  listEligibleUnitsForAgent: vi.fn().mockResolvedValue([]),
  getReservationForOrg: vi.fn().mockResolvedValue(null),
  getUnsignedReservationPdfService: vi.fn(),
  cancelReservationService: vi.fn(),
  approveReservationService: vi.fn(),
  rejectReservationService: vi.fn(),
  resubmitReservationService: vi.fn(),
  adminEditAfterSigningService: vi.fn(),
  getReservationEditHistory: vi.fn(),
}));

function makeApp(session: ReservationSession) {
  const app = new Hono<{ Variables: { session: ReservationSession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", reservationsRoutes);
  return app;
}

const adminSession: ReservationSession = {
  userId: "u1",
  orgId: "o1",
  partyId: "p1",
  role: "admin",
  operatorRole: "admin",
};

describe("reservationsRoutes — Zod error response shape", () => {
  it("POST / with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp(adminSession);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });

  it("PUT /:id/cancel with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp(adminSession);
    const res = await app.request("/res-123/cancel", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });

  it("PUT /:id/reject with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp(adminSession);
    const res = await app.request("/res-123/reject", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });
});
