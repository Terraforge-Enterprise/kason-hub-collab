import { z } from "zod";

export const taskStatusEnum = z.enum(["pool", "todo", "in_progress", "done", "archived"]);
export const taskBoardStatusEnum = z.enum(["pool", "todo", "in_progress", "done"]);
export const taskPriorityEnum = z.enum(["low", "medium", "high"]);
export const ticketStatusEnum = z.enum(["open", "in_progress", "resolved", "void"]);

export const createTaskSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    priority: taskPriorityEnum.default("medium"),
    category: z.string().max(100).optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    relatedUnitId: z.string().uuid().nullable().optional(),
    ticketId: z.string().uuid().nullable().optional(),
    dueOn: z.string().datetime().nullable().optional(),
    sprintId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    taskId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).nullable().optional(),
    priority: taskPriorityEnum.optional(),
    category: z.string().max(100).nullable().optional(),
    relatedUnitId: z.string().uuid().nullable().optional(),
    dueOn: z.string().datetime().nullable().optional(),
    sprintId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const moveTaskSchema = z
  .object({
    taskId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    status: taskBoardStatusEnum,
    position: z.number().int().min(0).optional(),
  })
  .strict();

export const assignTaskSchema = z
  .object({
    taskId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    assigneeUserId: z.string().uuid().nullable(),
  })
  .strict();

export const taskLifecycleSchema = z
  .object({ taskId: z.string().uuid(), updatedAt: z.string().datetime() })
  .strict();

export const listTasksQuerySchema = z
  .object({
    status: taskStatusEnum.optional(),
    assigneeUserId: z.union([z.string().uuid(), z.literal("unassigned")]).optional(),
    priority: taskPriorityEnum.optional(),
    category: z.string().max(100).optional(),
    relatedUnitId: z.string().uuid().optional(),
    sprintId: z.union([z.literal("null"), z.string().uuid()]).optional(),
  })
  .strict();

export const createTicketSchema = z
  .object({
    unitId: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category: z.string().max(100).optional(),
    warrantyFlag: z.boolean().default(false),
    // Seeds for the auto-spawned paired board Task — the Ticket row itself has
    // no priority/assignee/dueOn columns; these live on the Task side only.
    priority: taskPriorityEnum.default("medium"),
    assigneeUserId: z.string().uuid().nullable().optional(),
    dueOn: z.string().datetime().nullable().optional(),
    // NO attachmentKeys on create — the key prefix needs the ticket id, so evidence
    // is attached post-create via mint/complete (.strict() rejects a stray field).
  })
  .strict();

export const updateTicketSchema = z
  .object({
    ticketId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).nullable().optional(),
    category: z.string().max(100).nullable().optional(),
    warrantyFlag: z.boolean().optional(),
    status: z.enum(["open", "in_progress"]).optional(),
  })
  .strict();

export const resolveTicketSchema = z
  .object({
    ticketId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    entry: z.string().min(1).max(4000),
    attachmentKeys: z.array(z.string().min(1).max(512)).max(12).default([]),
    occurredOn: z.string().datetime(),
  })
  .strict();

export const ticketLifecycleSchema = z
  .object({ ticketId: z.string().uuid(), updatedAt: z.string().datetime() })
  .strict();

export const listTicketsQuerySchema = z
  .object({
    status: ticketStatusEnum.optional(),
    category: z.string().max(100).optional(),
    warrantyFlag: z.enum(["true", "false"]).optional(),
  })
  .strict();

export const quickLogSchema = z
  .object({
    unitId: z.string().uuid(),
    entry: z.string().min(1).max(4000),
    occurredOn: z.string().datetime(),
    attachmentKeys: z.array(z.string().min(1).max(512)).max(12).default([]),
    category: z.string().max(100).optional(),
    warrantyFlag: z.boolean().default(false),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export const attachmentUploadUrlSchema = z
  .object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive(),
  })
  .strict();

export const attachmentCompleteSchema = z
  .object({ storageKey: z.string().min(1).max(512) })
  .strict();

export type TaskStatus = z.infer<typeof taskStatusEnum>;
export type TaskPriority = z.infer<typeof taskPriorityEnum>;
export type TicketStatus = z.infer<typeof ticketStatusEnum>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
export type AssignTaskInput = z.infer<typeof assignTaskSchema>;
export type ListTasksQueryInput = z.infer<typeof listTasksQuerySchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ResolveTicketInput = z.infer<typeof resolveTicketSchema>;
export type ListTicketsQueryInput = z.infer<typeof listTicketsQuerySchema>;
export type QuickLogInput = z.infer<typeof quickLogSchema>;
export type AttachmentUploadUrlInput = z.infer<typeof attachmentUploadUrlSchema>;
export type AttachmentCompleteInput = z.infer<typeof attachmentCompleteSchema>;
