/**
 * Task 1 — closed-period error contract (R1/R2). Pure unit tests (no DB, no
 * RUN_INTEGRATION gate): the ClosedPeriodError class + toClosedPeriodBody builder
 * + the shared Zod body schema.
 *
 * The PPA flag (ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT) does not exist in the flag
 * registry yet; an absent flag is OFF. These tests toggle it via process.env to
 * prove the body reflects it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closedPeriodErrorBody } from "@kason/shared";
import { ClosedPeriodError, toClosedPeriodBody } from "../closed-period";

const PPA = "ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT";

describe("closed-period error contract (R1/R2)", () => {
  let savedPpa: string | undefined;
  beforeEach(() => {
    savedPpa = process.env[PPA];
    delete process.env[PPA];
  });
  afterEach(() => {
    if (savedPpa === undefined) delete process.env[PPA];
    else process.env[PPA] = savedPpa;
  });

  it("B1: PPA flag OFF → supported=false, suggestedPostingMonth=null, months pass through", () => {
    const err = new ClosedPeriodError({ originalBillingMonth: "2026-05", currentOpenMonth: "2026-07" });
    const body = toClosedPeriodBody(err);
    expect(body).toEqual({
      code: "closed_period",
      originalBillingMonth: "2026-05",
      currentOpenMonth: "2026-07",
      priorPeriodAdjustmentSupported: false,
      suggestedPostingMonth: null,
    });
  });

  it("B2: PPA flag ON → supported=true, suggestedPostingMonth = currentOpenMonth", () => {
    process.env[PPA] = "1";
    const err = new ClosedPeriodError({ originalBillingMonth: "2026-05", currentOpenMonth: "2026-07" });
    const body = toClosedPeriodBody(err);
    expect(body.priorPeriodAdjustmentSupported).toBe(true);
    expect(body.suggestedPostingMonth).toBe("2026-07");
    expect(body.code).toBe("closed_period");
  });

  it("B3: shared Zod schema accepts a valid body and rejects a malformed one", () => {
    const err = new ClosedPeriodError({ originalBillingMonth: "2026-05", currentOpenMonth: "2026-07" });
    const body = toClosedPeriodBody(err);
    expect(closedPeriodErrorBody.safeParse(body).success).toBe(true);
    // malformed: wrong code + non-YYYY-MM month
    expect(
      closedPeriodErrorBody.safeParse({ ...body, code: "nope", originalBillingMonth: "2026/05" }).success,
    ).toBe(false);
  });

  it("ClosedPeriodError is an Error with the four structured fields set", () => {
    const err = new ClosedPeriodError({ originalBillingMonth: "2026-05", currentOpenMonth: "2026-07" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClosedPeriodError");
    expect(err.originalBillingMonth).toBe("2026-05");
    expect(err.currentOpenMonth).toBe("2026-07");
  });
});
