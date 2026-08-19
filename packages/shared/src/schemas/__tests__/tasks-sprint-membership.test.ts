import { describe, expect, it } from "vitest";
import { createTaskSchema, updateTaskSchema, listTasksQuerySchema } from "../tasks";

const UUID = "11111111-1111-4111-8111-111111111111";
const ISO = "2026-06-19T00:00:00.000Z";

describe("task schema — additive sprintId membership (back-compatible)", () => {
  describe("createTaskSchema", () => {
    it("accepts a sprintId (new task lands in that sprint)", () => {
      expect(createTaskSchema.parse({ title: "t", sprintId: UUID }).sprintId).toBe(UUID);
    });
    it("accepts sprintId: null (Backlog)", () => {
      expect(createTaskSchema.parse({ title: "t", sprintId: null }).sprintId).toBeNull();
    });
    it("still parses without sprintId (back-compat)", () => {
      expect(createTaskSchema.parse({ title: "t" }).sprintId).toBeUndefined();
    });
  });

  describe("updateTaskSchema", () => {
    it("accepts sprintId to set membership", () => {
      expect(updateTaskSchema.parse({ taskId: UUID, updatedAt: ISO, sprintId: UUID }).sprintId).toBe(UUID);
    });
    it("accepts sprintId: null to move to Backlog", () => {
      expect(updateTaskSchema.parse({ taskId: UUID, updatedAt: ISO, sprintId: null }).sprintId).toBeNull();
    });
  });

  describe("listTasksQuerySchema", () => {
    it("accepts sprintId='null' (Backlog filter)", () => {
      expect(listTasksQuerySchema.parse({ sprintId: "null" })).toEqual({ sprintId: "null" });
    });
    it("accepts a uuid sprintId filter", () => {
      expect(listTasksQuerySchema.parse({ sprintId: UUID })).toEqual({ sprintId: UUID });
    });
    it("rejects a non-uuid, non-'null' sprintId", () => {
      expect(() => listTasksQuerySchema.parse({ sprintId: "bogus" })).toThrow();
    });
    it("still parses without sprintId (back-compat)", () => {
      expect(listTasksQuerySchema.parse({})).toEqual({});
    });
  });
});
