import { describe, expect, it } from "vitest";
import {
  createSprintSchema,
  updateSprintSchema,
  sprintLifecycleSchema,
  listSprintsQuerySchema,
  sprintVelocityQuerySchema,
  sprintTrendsQuerySchema,
  sprintStatusEnum,
} from "../sprints";

const UUID = "11111111-1111-4111-8111-111111111111";
const ISO = "2026-06-19T00:00:00.000Z";

describe("sprint schemas", () => {
  describe("createSprintSchema", () => {
    it("accepts an empty object (every field optional)", () => {
      expect(createSprintSchema.parse({})).toEqual({});
    });
    it("accepts name, goal, startsOn, endsOn", () => {
      const v = { name: "Sprint A", goal: "ship it", startsOn: ISO, endsOn: ISO };
      expect(createSprintSchema.parse(v)).toEqual(v);
    });
    it("rejects an unknown field (strict)", () => {
      expect(() => createSprintSchema.parse({ seq: 1 })).toThrow();
    });
    it("rejects a name longer than 100 chars", () => {
      expect(() => createSprintSchema.parse({ name: "x".repeat(101) })).toThrow();
    });
    it("rejects a non-ISO startsOn", () => {
      expect(() => createSprintSchema.parse({ startsOn: "2026-06-19" })).toThrow();
    });
  });

  describe("updateSprintSchema", () => {
    it("requires sprintId + updatedAt", () => {
      expect(() => updateSprintSchema.parse({ name: "x" })).toThrow();
    });
    it("accepts nullable name/goal/dates alongside the lock token", () => {
      const v = { sprintId: UUID, updatedAt: ISO, name: null, goal: null, startsOn: null, endsOn: null };
      expect(updateSprintSchema.parse(v)).toEqual(v);
    });
    it("rejects a non-uuid sprintId", () => {
      expect(() => updateSprintSchema.parse({ sprintId: "nope", updatedAt: ISO })).toThrow();
    });
  });

  describe("sprintLifecycleSchema", () => {
    it("accepts sprintId + updatedAt", () => {
      expect(sprintLifecycleSchema.parse({ sprintId: UUID, updatedAt: ISO })).toEqual({
        sprintId: UUID,
        updatedAt: ISO,
      });
    });
    it("rejects extra fields (strict)", () => {
      expect(() => sprintLifecycleSchema.parse({ sprintId: UUID, updatedAt: ISO, name: "x" })).toThrow();
    });
  });

  describe("listSprintsQuerySchema", () => {
    it("accepts a valid status", () => {
      expect(listSprintsQuerySchema.parse({ status: "active" })).toEqual({ status: "active" });
    });
    it("accepts an empty query", () => {
      expect(listSprintsQuerySchema.parse({})).toEqual({});
    });
    it("rejects an invalid status", () => {
      expect(() => listSprintsQuerySchema.parse({ status: "bogus" })).toThrow();
    });
  });

  describe("sprintVelocityQuerySchema", () => {
    it("coerces a numeric-string limit", () => {
      expect(sprintVelocityQuerySchema.parse({ limit: "8" })).toEqual({ limit: 8 });
    });
    it("accepts an empty query", () => {
      expect(sprintVelocityQuerySchema.parse({})).toEqual({});
    });
    it("rejects a limit over 50", () => {
      expect(() => sprintVelocityQuerySchema.parse({ limit: "51" })).toThrow();
    });
    it("rejects a limit below 1", () => {
      expect(() => sprintVelocityQuerySchema.parse({ limit: "0" })).toThrow();
    });
  });

  describe("sprintTrendsQuerySchema", () => {
    it("coerces a numeric-string window", () => {
      expect(sprintTrendsQuerySchema.parse({ window: "8" })).toEqual({ window: 8 });
    });
    it("accepts an empty query (window optional → service default)", () => {
      expect(sprintTrendsQuerySchema.parse({})).toEqual({});
    });
    it("rejects a window over 50", () => {
      expect(() => sprintTrendsQuerySchema.parse({ window: "51" })).toThrow();
    });
    it("rejects a window below 1", () => {
      expect(() => sprintTrendsQuerySchema.parse({ window: "0" })).toThrow();
    });
    it("rejects an unknown field (strict)", () => {
      expect(() => sprintTrendsQuerySchema.parse({ window: 8, limit: 1 })).toThrow();
    });
  });

  describe("sprintStatusEnum", () => {
    it("is exactly planned|active|completed", () => {
      expect(sprintStatusEnum.options).toEqual(["planned", "active", "completed"]);
    });
  });
});
