import { describe, it, expect } from "vitest";
import { z } from "zod";
import { formatZodError } from "../zod-error-mapper";

// Helper: run safeParse on a schema + bad data and assert it failed.
function parseError(schema: z.ZodTypeAny, data: unknown): z.ZodError {
  const result = schema.safeParse(data);
  if (result.success) throw new Error("Expected parse to fail");
  return result.error;
}

describe("formatZodError", () => {
  describe("missing required field", () => {
    it("returns { message, fieldErrors } for a single missing required field", () => {
      const schema = z.object({ unitNo: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      expect(result).toHaveProperty("message");
      expect(result).toHaveProperty("fieldErrors");
      expect(result.fieldErrors).toHaveProperty("unitNo");
    });

    it("single-field message is the field's own error message, not generic", () => {
      const schema = z.object({ unitNo: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      // Single field: message === the field error itself (not "Check X fields")
      expect(result.message).toBe(result.fieldErrors["unitNo"]);
      expect(result.message).not.toMatch(/check the highlighted/i);
    });

    it("uses domain label when available (unitNo → 'Unit number')", () => {
      const schema = z.object({ unitNo: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["unitNo"]).toContain("Unit number");
    });
  });

  describe("fallback when no domain dictionary entry", () => {
    it("falls back to raw field path when domain has no label for the field", () => {
      const schema = z.object({ unknownFieldXYZ: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      // No label for 'unknownFieldXYZ' → path used as label
      expect(result.fieldErrors["unknownFieldXYZ"]).toContain("unknownFieldXYZ");
    });

    it("falls back to raw field path when no domain is provided", () => {
      const schema = z.object({ myField: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err);

      expect(result.fieldErrors["myField"]).toContain("myField");
    });
  });

  describe("nested object paths with dot notation", () => {
    it("joins nested path with dot notation (e.g. 'address.street')", () => {
      const schema = z.object({ address: z.object({ street: z.string() }) });
      const err = parseError(schema, { address: {} });
      const result = formatZodError(err);

      expect(result.fieldErrors).toHaveProperty("address.street");
    });

    it("uses raw dot-path as label fallback for nested fields", () => {
      const schema = z.object({ address: z.object({ street: z.string() }) });
      const err = parseError(schema, { address: {} });
      const result = formatZodError(err);

      expect(result.fieldErrors["address.street"]).toContain("address.street");
    });
  });

  describe("multi-field error message", () => {
    it("message is 'Check the highlighted N fields and try again.' for multiple errors", () => {
      const schema = z.object({
        unitNo: z.string(),
        propertyId: z.string(),
      });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.message).toBe("Check the highlighted 2 fields and try again.");
      expect(Object.keys(result.fieldErrors)).toHaveLength(2);
    });

    it("message count reflects actual number of field errors", () => {
      const schema = z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
      });
      const err = parseError(schema, {});
      const result = formatZodError(err);

      expect(result.message).toBe("Check the highlighted 3 fields and try again.");
    });
  });

  describe("humanizeIssue code handling", () => {
    it("labels invalid_type (missing) as '<Label> is required.'", () => {
      const schema = z.object({ rentalRate: z.number() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["rentalRate"]).toBe("Rental rate is required.");
    });

    it("labels too_small as '<Label> is too short.'", () => {
      const schema = z.object({ unitNo: z.string().min(5) });
      const err = parseError(schema, { unitNo: "ab" });
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["unitNo"]).toBe("Unit number is too short.");
    });

    it("labels too_big as '<Label> is too long.'", () => {
      const schema = z.object({ unitNo: z.string().max(3) });
      const err = parseError(schema, { unitNo: "toolong" });
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["unitNo"]).toBe("Unit number is too long.");
    });

    it("labels invalid_format (e.g. bad email) as '<Label> has an invalid format.'", () => {
      const schema = z.object({ unitNo: z.string().email() });
      const err = parseError(schema, { unitNo: "not-an-email" });
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["unitNo"]).toBe("Unit number has an invalid format.");
    });

    it("falls back to '<label>: <raw message>' for unknown codes", () => {
      // Simulate an unknown code by calling formatZodError with a manually
      // constructed ZodError containing a custom issue code.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fakeErr = new z.ZodError([
        {
          code: "custom" as any,
          path: ["myField"],
          message: "something custom",
        },
      ]);
      const result = formatZodError(fakeErr);

      expect(result.fieldErrors["myField"]).toBe("myField: something custom");
    });

    it("invalid_type with received='string' (wrong type, not missing) → 'has an invalid format'", () => {
      // Pass a string where a number is expected — received will be "string", not "undefined"
      const schema = z.object({ rentalRate: z.number() });
      const err = parseError(schema, { rentalRate: "abc" });
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["rentalRate"]).toBe("Rental rate has an invalid format.");
    });

    it("invalid_type with missing field (received='undefined') → 'is required'", () => {
      const schema = z.object({ rentalRate: z.number() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["rentalRate"]).toBe("Rental rate is required.");
    });

    it("z.enum failure → 'is not a valid option'", () => {
      const schema = z.object({ mode: z.enum(["A", "B"]) });
      const err = parseError(schema, { mode: "C" });
      const result = formatZodError(err);

      expect(result.fieldErrors["mode"]).toBe("mode is not a valid option.");
    });

    it("z.number().min() failure → 'is too small' (not 'too short')", () => {
      const schema = z.object({ rentalRate: z.number().min(100) });
      const err = parseError(schema, { rentalRate: 5 });
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["rentalRate"]).toBe("Rental rate is too small.");
    });

    it("z.string().min() failure → 'is too short' (string, unchanged)", () => {
      const schema = z.object({ unitNo: z.string().min(5) });
      const err = parseError(schema, { unitNo: "ab" });
      const result = formatZodError(err, { domain: "inventory" });

      expect(result.fieldErrors["unitNo"]).toBe("Unit number is too short.");
    });
  });

  // ── task A2 (#3.3): DOMAIN_FIELD_LABELS.parties was `{}` — every party
  // validation error leaked the raw camelCase field name (e.g.
  // "monthlyIncome is required.") straight to the user instead of a human
  // label. Populated with a label for every field surfaced by the
  // create/update party schemas (parties.validation.ts / @kason/shared).
  describe("parties labels", () => {
    it("labels monthlyIncome as 'Monthly income' for the parties domain", () => {
      const schema = z.object({ monthlyIncome: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "parties" });

      expect(result.fieldErrors["monthlyIncome"]).toContain("Monthly income");
    });

    it.each([
      ["displayName", "Display name"],
      ["legalName", "Company / legal name"],
      ["primaryEmail", "Email"],
      ["primaryPhone", "Phone"],
      ["whatsappPhone", "WhatsApp"],
      ["idType", "ID type"],
      ["idNumber", "ID number"],
      ["nationality", "Nationality"],
      ["gender", "Gender"],
      ["dateOfBirth", "Date of birth"],
      ["occupation", "Occupation"],
      ["employerName", "Employer"],
      ["employerAddress", "Employer address"],
      ["emergencyContactName", "Emergency contact name"],
      ["emergencyContactPhone", "Emergency contact phone"],
      ["emergencyContactRelation", "Emergency contact relation"],
      ["bankName", "Bank name"],
      ["bankAccountHolder", "Account holder"],
      ["bankAccountNumber", "Account number"],
      ["reason", "Reason"],
    ])("labels %s as '%s' for the parties domain", (field, label) => {
      const schema = z.object({ [field]: z.string() });
      const err = parseError(schema, {});
      const result = formatZodError(err, { domain: "parties" });

      // Exact match, not .toContain(): a couple of raw camelCase field names
      // (e.g. "primaryEmail", "primaryPhone") already contain their target
      // label as a substring ("primaryEmail" contains "Email"), which would
      // let this assertion pass vacuously against the pre-fix `{}` map.
      expect(result.fieldErrors[field]).toBe(`${label} is required.`);
    });
  });
});
