import { describe, expect, it } from "vitest";
import { createUserSchema, resetPasswordSchema, updateUserSchema } from "../users.validation";

describe("createUserSchema", () => {
  it("rejects passwords under 6 characters", () => {
    const result = createUserSchema.safeParse({
      email: "x@y.com",
      fullName: "X Y",
      role: "editor",
      password: "abc12", // 5 chars
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.password?.[0]).toMatch(/at least 6 characters/);
    }
  });

  it("accepts a 6-character password", () => {
    const result = createUserSchema.safeParse({
      email: "x@y.com",
      fullName: "X Y",
      role: "editor",
      password: "abcd12", // 6 chars
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password", () => {
    const result = createUserSchema.safeParse({
      email: "x@y.com",
      fullName: "X Y",
      role: "editor",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("role enum accepts accountant", () => {
  it("accepts the accountant role on create", () => {
    const r = createUserSchema.safeParse({
      email: "a@b.com", fullName: "Acc", role: "accountant", password: "secret1",
    });
    expect(r.success).toBe(true);
  });

  it("accepts the accountant role on update", () => {
    expect(updateUserSchema.safeParse({ role: "accountant" }).success).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(createUserSchema.safeParse({
      email: "a@b.com", fullName: "Acc", role: "superuser", password: "secret1",
    }).success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  it("rejects passwords under 6 characters", () => {
    const result = resetPasswordSchema.safeParse({
      password: "abc12", // 5 chars
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.password?.[0]).toMatch(/at least 6 characters/);
    }
  });

  it("accepts a 6-character password", () => {
    const result = resetPasswordSchema.safeParse({
      password: "abcd12", // 6 chars
    });
    expect(result.success).toBe(true);
  });
});
