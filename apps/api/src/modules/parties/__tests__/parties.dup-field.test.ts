import { describe, it, expect } from "vitest";
import { Prisma } from "@kason/db";
import { contactUniqueViolationField, describeContactViolation } from "../parties.repository";

// The race fallback: two concurrent creates pass the app-level pre-check, then
// the partial unique index (Party_org_email_unique / Party_org_phone_unique)
// rejects the loser with a P2002. contactUniqueViolationField maps that index
// name (Prisma reports it in meta.target) back to the form field so the client
// can still turn the offending input red instead of showing a generic toast.
function p2002(target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

describe("contactUniqueViolationField", () => {
  it("maps the phone partial-unique index → primaryPhone", () => {
    expect(contactUniqueViolationField(p2002("Party_org_phone_unique"))).toBe("primaryPhone");
  });

  it("maps the email partial-unique index → primaryEmail", () => {
    expect(contactUniqueViolationField(p2002("Party_org_email_unique"))).toBe("primaryEmail");
  });

  it("maps an array-form target (column list) → primaryEmail", () => {
    expect(contactUniqueViolationField(p2002(["organizationId", "primaryEmail"]))).toBe("primaryEmail");
  });

  it("returns null for a non-P2002 error", () => {
    expect(contactUniqueViolationField(new Error("boom"))).toBeNull();
  });
});

describe("describeContactViolation (race fallback → client-ready conflict)", () => {
  it("phone violation → 409, phone-specific message, fieldErrors.primaryPhone", () => {
    expect(describeContactViolation(p2002("Party_org_phone_unique"), "tenant")).toEqual({
      status: 409,
      error: expect.stringMatching(/tenant.*phone number/i),
      fieldErrors: { primaryPhone: expect.any(String) },
    });
  });

  it("email violation → 409, email-specific message, fieldErrors.primaryEmail (owner subject)", () => {
    expect(describeContactViolation(p2002("Party_org_email_unique"), "owner")).toEqual({
      status: 409,
      error: expect.stringMatching(/owner.*email/i),
      fieldErrors: { primaryEmail: expect.any(String) },
    });
  });

  it("P2002 with an undeterminable target → generic message, no fieldErrors", () => {
    const result = describeContactViolation(p2002("some_other_index"), "tenant");
    expect(result?.status).toBe(409);
    expect(result?.error).toMatch(/phone or email/i);
    expect(result?.fieldErrors).toBeUndefined();
  });

  it("returns null for a non-P2002 error so the caller rethrows", () => {
    expect(describeContactViolation(new Error("boom"), "tenant")).toBeNull();
  });
});
