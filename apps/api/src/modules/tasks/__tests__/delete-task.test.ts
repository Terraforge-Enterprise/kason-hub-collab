import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/storage", () => ({
  deleteObjectsBestEffort: vi.fn().mockResolvedValue({ deleted: 2, failed: 0 }),
  createSignedDownloadUrl: vi.fn().mockResolvedValue("https://example.com/signed"),
}));

vi.mock("../tasks.repository", () => ({
  findTask: vi.fn(),
  deleteTaskRow: vi.fn(),
  withTransaction: vi.fn((fn: (tx: unknown) => unknown) => fn({})),
  // Stubs for other exports consumed by tasks.service.ts imports
  listTasks: vi.fn(),
  findTaskInTx: vi.fn(),
  createTaskRow: vi.fn(),
  updateTaskGuarded: vi.fn(),
  renumberLane: vi.fn(),
  nextLaneSortOrder: vi.fn(),
  findActiveOperator: vi.fn(),
  getUsersByIds: vi.fn().mockResolvedValue([]),
  findListing: vi.fn(),
  findTicketById: vi.fn(),
  findOpenTaskByTicketId: vi.fn(),
}));

vi.mock("../tickets.repository", () => ({
  collectTicketStorageKeys: vi.fn().mockResolvedValue([]),
  deleteTicketCascade: vi.fn(),
  // Stubs for other exports consumed by tasks.service.ts
  listUnitTickets: vi.fn(),
  findTicket: vi.fn(),
  findTicketInTx: vi.fn(),
  createTicketRow: vi.fn(),
  updateTicketGuarded: vi.fn(),
  listUnitHistory: vi.fn(),
  createHistoryRow: vi.fn(),
}));

vi.mock("../sprints.repository", () => ({
  findSprint: vi.fn(),
}));

vi.mock("../mirror", () => ({
  mirrorTicketFromTask: vi.fn(),
  spawnTicketForTask: vi.fn(),
}));

import { recordAudit } from "../../../lib/audit";
import { deleteObjectsBestEffort } from "../../../lib/storage";
import { findTask, deleteTaskRow } from "../tasks.repository";
import { collectTicketStorageKeys, deleteTicketCascade } from "../tickets.repository";
import { deleteTaskService } from "../tasks.service";

const ctx = {
  orgId: "org1",
  actorUserId: "u1",
  actorRole: "admin" as const,
  ip: undefined,
  userAgent: undefined,
};

beforeEach(() => vi.clearAllMocks());

describe("deleteTaskService", () => {
  it("404s when the task is missing", async () => {
    vi.mocked(findTask).mockResolvedValue(null);
    const r = await deleteTaskService(ctx, "missing");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("deletes the row, audits, and best-effort removes attachment objects (no ticket)", async () => {
    vi.mocked(findTask).mockResolvedValue({
      id: "t1",
      title: "Oops",
      status: "todo",
      ticketId: null,
      attachmentKeys: ["tasks/t1/a.jpg", "tasks/t1/b.jpg"],
    } as never);
    const r = await deleteTaskService(ctx, "t1");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(vi.mocked(deleteTaskRow)).toHaveBeenCalledWith(expect.anything(), "org1", "t1");
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.task.delete", entityType: "Task", entityId: "t1" }),
    );
    expect(vi.mocked(deleteTicketCascade)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteObjectsBestEffort)).toHaveBeenCalledWith([
      "tasks/t1/a.jpg",
      "tasks/t1/b.jpg",
    ]);
  });

  it("cascades to paired ticket, audits both, and collects all storage keys", async () => {
    vi.mocked(findTask).mockResolvedValue({
      id: "t2",
      title: "Linked",
      status: "todo",
      ticketId: "ticket-99",
      attachmentKeys: ["tasks/t2/file.pdf"],
    } as never);
    vi.mocked(collectTicketStorageKeys).mockResolvedValue([
      "tickets/ticket-99/photo.jpg",
      "history/ticket-99/evidence.jpg",
    ]);

    const r = await deleteTaskService(ctx, "t2");
    expect(r.ok).toBe(true);
    expect(vi.mocked(collectTicketStorageKeys)).toHaveBeenCalledWith("org1", "ticket-99");
    expect(vi.mocked(deleteTicketCascade)).toHaveBeenCalledWith(
      expect.anything(),
      "org1",
      "ticket-99",
    );
    expect(vi.mocked(deleteObjectsBestEffort)).toHaveBeenCalledWith([
      "tasks/t2/file.pdf",
      "tickets/ticket-99/photo.jpg",
      "history/ticket-99/evidence.jpg",
    ]);
    // Both audit actions must be recorded
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.task.delete", entityType: "Task", entityId: "t2" }),
    );
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.ticket.delete",
        entityType: "Ticket",
        entityId: "ticket-99",
      }),
    );
  });
});
