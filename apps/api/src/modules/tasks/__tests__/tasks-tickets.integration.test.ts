/**
 * Integration tests for the M7 Tasks + Tickets module. Hits a real LOCAL Postgres.
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="<local>" \
 *     npx vitest run src/modules/tasks/__tests__/tasks-tickets.integration.test.ts
 *
 * Patterns (per docs in the foundation smoke + reservations integration tests):
 * - Services open their OWN transactions via withTransaction, so service-level
 *   cases use the reservations-style fixed-UUID seed + org-scoped deleteMany
 *   cleanup (cleanup BEFORE each seed, and a final afterAll cleanup).
 * - The RollbackSentinel pattern is used only where THIS file controls the
 *   transaction (the repository-level renumberLane case) — nothing commits.
 * Zero residue either way.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import {
  archiveTaskService,
  createTaskService,
  getTaskService,
  listTasksService,
  moveTaskService,
  updateTaskService,
} from "../tasks.service";
import { listTasks, renumberLane } from "../tasks.repository";
import {
  createTicketService,
  getTicketService,
  listUnitTicketsService,
  quickLogService,
  resolveTicketService,
} from "../tickets.service";
import { findTicket } from "../tickets.repository";
import type { TasksActorCtx } from "../tasks.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
// (Project rule: the client UAT Supabase must never be touched by tests.)
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

class RollbackSentinel extends Error {}

const STALE = "Record changed — reloaded";
const STALE_UPDATED_AT = "2000-01-01T00:00:00.000Z";

// Fixed UUIDs — disjoint from every other integration test's constants.
const ORG_A = "a0000000-0000-4000-8000-0000000000a1";
const ORG_B = "b0000000-0000-4000-8000-0000000000b1";
const USER_A = "a0000000-0000-4000-8000-0000000000a2";
const PARTY_A = "a0000000-0000-4000-8000-0000000000a3";
const PROPERTY_A = "a0000000-0000-4000-8000-0000000000a4";
const APARTMENT_A = "a0000000-0000-4000-8000-0000000000a5";
const UNIT_A = "a0000000-0000-4000-8000-0000000000a6";

const CTX_A: TasksActorCtx = { orgId: ORG_A, actorUserId: USER_A, actorRole: "admin" };
// Read-only services never write audit rows, so org B needs no User of its own.
const CTX_B: TasksActorCtx = { orgId: ORG_B, actorUserId: USER_A, actorRole: "admin" };

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG_A,
      name: "TT Int Org A",
      slug: "tt-int-org-a",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.organization.create({
    data: {
      id: ORG_B,
      name: "TT Int Org B",
      slug: "tt-int-org-b",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // Operator invariant: every operator User carries a paired individual Party.
  await db.party.create({
    data: {
      id: PARTY_A,
      organizationId: ORG_A,
      displayName: "TT Operator",
      partyType: "individual",
      status: "active",
    },
  });
  // Real User row required: AuditLog.actorUserId is FK → User (onDelete: Restrict).
  await db.user.create({
    data: {
      id: USER_A,
      organizationId: ORG_A,
      email: "tt-int-operator@example.com",
      fullName: "TT Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY_A,
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY_A,
      organizationId: ORG_A,
      name: "TT Test Property",
      propertyCode: "TT-INT-1",
      propertyType: "residential",
      addressLine1: "1 Test St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APARTMENT_A,
      organizationId: ORG_A,
      propertyId: PROPERTY_A,
      unitCode: "TT-A-101",
      listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: UNIT_A,
      organizationId: ORG_A,
      apartmentId: APARTMENT_A,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
    },
  });
}

/** Delete everything in FK-safe order (children first; AuditLog before User — Restrict FK). */
async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG_A, ORG_B] };
  await db.ticketHistory.deleteMany({ where: { organizationId: orgs } });
  await db.ticket.deleteMany({ where: { organizationId: orgs } });
  await db.task.deleteMany({ where: { organizationId: orgs } });
  await db.auditLog.deleteMany({ where: { organizationId: orgs } });
  await db.listing.deleteMany({ where: { organizationId: orgs } });
  await db.apartment.deleteMany({ where: { organizationId: orgs } });
  await db.property.deleteMany({ where: { organizationId: orgs } });
  await db.user.deleteMany({ where: { organizationId: orgs } });
  await db.party.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

async function seedOpenTicket(title = "Leaky tap") {
  const res = await createTicketService(CTX_A, { unitId: UNIT_A, title, warrantyFlag: false, priority: "medium" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("ticket seed failed");
  return res.data;
}

async function seedTodoTask(title: string) {
  const res = await createTaskService(CTX_A, {
    title,
    priority: "medium",
    assigneeUserId: USER_A, // assigned → lands in the todo lane
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("task seed failed");
  return res.data;
}

dn("tasks + tickets (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
    // Residue check: nothing keyed to the fixed org UUIDs survives the run.
    const db = getDb();
    const orgs = { in: [ORG_A, ORG_B] };
    expect(await db.ticketHistory.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.ticket.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.task.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.listing.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.user.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.organization.count({ where: { id: orgs } })).toBe(0);
  });

  // Pattern: reservations-style (service owns its transaction) + deleteMany cleanup.
  it("resolve atomicity: resolves the ticket and writes exactly one history row", async () => {
    const ticket = await seedOpenTicket();

    const res = await resolveTicketService(CTX_A, {
      ticketId: ticket.id,
      updatedAt: ticket.updatedAt,
      entry: "Replaced the tap washer",
      attachmentKeys: [],
      occurredOn: "2026-06-10T08:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ticket.status).toBe("resolved");
    expect(res.data.ticket.resolvedAt).not.toBeNull();
    // historyCount on the returned ticket already includes the new entry.
    expect(res.data.ticket.historyCount).toBe(1);
    expect(res.data.history.actor).toEqual({ id: USER_A, fullName: "TT Operator" });

    const db = getDb();
    const rows = await db.ticketHistory.findMany({ where: { ticketId: ticket.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitId).toBe(UNIT_A);
    expect(rows[0]!.entry).toBe("Replaced the tap washer");
    expect(rows[0]!.actorUserId).toBe(USER_A);
  });

  // Pattern: reservations-style. The guarded update fails first, so the whole
  // service transaction (history insert + audit) must not have happened.
  it("resolve atomicity: stale updatedAt → 409 and NO history row is created", async () => {
    const ticket = await seedOpenTicket();

    const res = await resolveTicketService(CTX_A, {
      ticketId: ticket.id,
      updatedAt: STALE_UPDATED_AT,
      entry: "should never be written",
      attachmentKeys: [],
      occurredOn: "2026-06-10T08:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.error).toBe(STALE);

    const db = getDb();
    expect(await db.ticketHistory.count({ where: { ticketId: ticket.id } })).toBe(0);
    const fresh = await db.ticket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe("open");
    expect(fresh!.resolvedAt).toBeNull();
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "tasks.ticket.resolve" },
      }),
    ).toBe(0);
  });

  // Pattern: reservations-style. Ticket + history + audit land in ONE service tx.
  it("quick-log atomicity: one resolved ticket + one linked history + one audit row", async () => {
    const entry = "1701 kitchen light replaced";
    const res = await quickLogService(CTX_A, {
      unitId: UNIT_A,
      entry,
      occurredOn: "2026-06-10T09:00:00.000Z",
      attachmentKeys: [],
      warrantyFlag: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(201);
    expect(res.data.history.ticketId).toBe(res.data.ticketId);

    const db = getDb();
    const ticket = await db.ticket.findUnique({ where: { id: res.data.ticketId } });
    expect(ticket).not.toBeNull();
    expect(ticket!.status).toBe("resolved");
    expect(ticket!.title).toBe(entry); // short entry → title derived verbatim
    expect(ticket!.unitId).toBe(UNIT_A);
    expect(ticket!.resolvedAt).not.toBeNull();

    const history = await db.ticketHistory.findMany({
      where: { ticketId: res.data.ticketId },
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(res.data.history.id);

    const audits = await db.auditLog.findMany({
      where: { organizationId: ORG_A, action: "tasks.history.quicklog" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe("TicketHistory");
    expect(audits[0]!.entityId).toBe(res.data.history.id);
  });

  // Pattern: reservations-style. Every read path is ctx.orgId-scoped.
  it("cross-org isolation: org B cannot see org A's ticket, task, or unit", async () => {
    const ticket = await seedOpenTicket();
    const task = await seedTodoTask("Org A task");

    // Org A sees its own rows.
    const ownTicket = await getTicketService(CTX_A, ticket.id);
    expect(ownTicket.ok).toBe(true);
    const ownTask = await getTaskService(CTX_A, task.id);
    expect(ownTask.ok).toBe(true);

    // Org B: service 404s + repository null.
    const bTicket = await getTicketService(CTX_B, ticket.id);
    expect(bTicket.ok).toBe(false);
    if (!bTicket.ok) expect(bTicket.status).toBe(404);

    expect(await findTicket(ORG_B, ticket.id)).toBeNull();

    const bTask = await getTaskService(CTX_B, task.id);
    expect(bTask.ok).toBe(false);
    if (!bTask.ok) expect(bTask.status).toBe(404);

    // Even the unit itself doesn't resolve cross-org — org B sees nothing.
    const bList = await listUnitTicketsService(CTX_B, UNIT_A, {});
    expect(bList.ok).toBe(false);
    if (!bList.ok) {
      expect(bList.status).toBe(404);
      expect(bList.error).toBe("Unit not found");
    }
  });

  // Pattern: reservations-style. updatedAt-in-WHERE guard → 409 with the exact em-dash copy.
  it("optimistic concurrency: stale updatedAt on updateTask → 409 'Record changed — reloaded'", async () => {
    const task = await seedTodoTask("Concurrency probe");

    const res = await updateTaskService(CTX_A, {
      taskId: task.id,
      updatedAt: STALE_UPDATED_AT,
      title: "should not apply",
    });
    expect(res).toEqual({ ok: false, status: 409, error: STALE });

    const db = getDb();
    const fresh = await db.task.findUnique({ where: { id: task.id } });
    expect(fresh!.title).toBe("Concurrency probe");
  });

  // Pattern: reservations-style (moveTaskService owns its transaction).
  it("lane renumber: moving task #3 to position 0 yields contiguous [0,1,2] with #3 first", async () => {
    const t1 = await seedTodoTask("todo-1");
    const t2 = await seedTodoTask("todo-2");
    const t3 = await seedTodoTask("todo-3");
    expect([t1.sortOrder, t2.sortOrder, t3.sortOrder]).toEqual([0, 1, 2]);

    const res = await moveTaskService(CTX_A, {
      taskId: t3.id,
      updatedAt: t3.updatedAt,
      status: "todo",
      position: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sortOrder).toBe(0);

    const db = getDb();
    const lane = await db.task.findMany({
      where: { organizationId: ORG_A, status: "todo" },
      orderBy: { sortOrder: "asc" },
      select: { id: true, sortOrder: true },
    });
    expect(lane.map((t) => t.sortOrder)).toEqual([0, 1, 2]);
    expect(lane.map((t) => t.id)).toEqual([t3.id, t1.id, t2.id]);
  });

  // Pattern: RollbackSentinel — this test controls the transaction itself and
  // calls the repository directly, so nothing commits and no cleanup is needed.
  it("lane renumber (repository, rolled back): renumberLane writes contiguous orders in-tx", async () => {
    const db = getDb();
    await expect(
      db.$transaction(async (tx) => {
        const mk = (title: string, sortOrder: number) =>
          tx.task.create({
            data: {
              organizationId: ORG_A,
              title,
              status: "todo",
              sortOrder,
              createdBy: USER_A,
            },
          });
        const a = await mk("tx-a", 0);
        const b = await mk("tx-b", 1);
        const c = await mk("tx-c", 2);

        await renumberLane(tx, ORG_A, "todo", c.id, 0);

        const lane = await tx.task.findMany({
          where: { organizationId: ORG_A, status: "todo" },
          orderBy: { sortOrder: "asc" },
          select: { id: true, sortOrder: true },
        });
        expect(lane.map((t) => t.sortOrder)).toEqual([0, 1, 2]);
        expect(lane.map((t) => t.id)).toEqual([c.id, a.id, b.id]);

        throw new RollbackSentinel("rollback");
      }),
    ).rejects.toThrow(RollbackSentinel);

    // The sentinel rolled everything back — the lane never existed.
    expect(await db.task.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  // Pattern: reservations-style (listTasks is an org-scoped read over committed rows).
  it("list filters: archived tasks are excluded by default, returned with status=archived", async () => {
    await seedTodoTask("active-1");
    await seedTodoTask("active-2");
    // Archived row seeded directly — repository-level read test.
    const db = getDb();
    await db.task.create({
      data: {
        organizationId: ORG_A,
        title: "old archived task",
        status: "archived",
        createdBy: USER_A,
      },
    });

    const active = await listTasks(ORG_A, {});
    expect(active).toHaveLength(2);
    expect(active.every((t) => t.status !== "archived")).toBe(true);

    const archived = await listTasks(ORG_A, { status: "archived" });
    expect(archived).toHaveLength(1);
    expect(archived[0]!.title).toBe("old archived task");
    expect(archived[0]!.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// Mirror end-to-end integration tests
//
// These tests verify the bidirectional ticket⇄task auto-spawn and status
// mirror chains via real service calls against LOCAL Postgres (same guard as
// the parent describe block above).
// ---------------------------------------------------------------------------
dn("ticket⇄task mirror end-to-end (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
    // Residue check: nothing keyed to the fixed org UUIDs survives the run.
    const db = getDb();
    const orgs = { in: [ORG_A, ORG_B] };
    expect(await db.ticketHistory.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.ticket.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.task.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.listing.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.user.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.organization.count({ where: { id: orgs } })).toBe(0);
  });

  // Pattern: POST a ticket → GET /tasks shows a pool task carrying that ticketId.
  it("spawn: POST ticket on a unit → tasks list shows a pool task with ticketId", async () => {
    const ticketRes = await createTicketService(CTX_A, {
      unitId: UNIT_A,
      title: "Mirror test — leaky tap",
      warrantyFlag: false, priority: "medium",
    });
    expect(ticketRes.ok).toBe(true);
    if (!ticketRes.ok) return;
    const ticket = ticketRes.data;
    expect(ticket.status).toBe("open");

    // The service auto-spawns a mirrored pool task.
    const taskListRes = await listTasksService(CTX_A, {});
    expect(taskListRes.ok).toBe(true);
    if (!taskListRes.ok) return;
    const mirrored = taskListRes.data.find((t) => t.ticketId === ticket.id);
    expect(mirrored).toBeDefined();
    expect(mirrored!.status).toBe("pool");
    expect(mirrored!.ticketId).toBe(ticket.id);
    expect(mirrored!.relatedUnit?.id).toBe(UNIT_A);
  });

  // Pattern: resolve the ticket → the linked pool/todo task becomes done.
  it("ticket resolved → linked task status becomes done", async () => {
    const ticketRes = await createTicketService(CTX_A, {
      unitId: UNIT_A,
      title: "AC broken",
      warrantyFlag: false, priority: "medium",
    });
    expect(ticketRes.ok).toBe(true);
    if (!ticketRes.ok) return;
    const ticket = ticketRes.data;

    // Confirm the mirror task was spawned.
    const taskListBefore = await listTasksService(CTX_A, {});
    expect(taskListBefore.ok).toBe(true);
    if (!taskListBefore.ok) return;
    const mirrorTask = taskListBefore.data.find((t) => t.ticketId === ticket.id);
    expect(mirrorTask).toBeDefined();

    // Resolve the ticket.
    const resolveRes = await resolveTicketService(CTX_A, {
      ticketId: ticket.id,
      updatedAt: ticket.updatedAt,
      entry: "Fixed the AC unit",
      attachmentKeys: [],
      occurredOn: "2026-06-22T09:00:00.000Z",
    });
    expect(resolveRes.ok).toBe(true);
    if (!resolveRes.ok) return;
    expect(resolveRes.data.ticket.status).toBe("resolved");

    // The linked task should now be done.
    const taskAfter = await getTaskService(CTX_A, mirrorTask!.id);
    expect(taskAfter.ok).toBe(true);
    if (!taskAfter.ok) return;
    expect(taskAfter.data.status).toBe("done");
  });

  // Pattern: POST a task with relatedUnitId (no ticketId) → that unit's tickets include the new open ticket.
  it("spawn: POST task with relatedUnitId → unit tickets list shows a new open ticket", async () => {
    const taskRes = await createTaskService(CTX_A, {
      title: "Replace door lock",
      priority: "medium",
      relatedUnitId: UNIT_A,
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.data;
    expect(task.ticketId).not.toBeNull();

    // The linked ticket must appear in the unit's ticket list.
    const ticketsRes = await listUnitTicketsService(CTX_A, UNIT_A, {});
    expect(ticketsRes.ok).toBe(true);
    if (!ticketsRes.ok) return;
    const spawnedTicket = ticketsRes.data.find((tk) => tk.id === task.ticketId);
    expect(spawnedTicket).toBeDefined();
    expect(spawnedTicket!.status).toBe("open");
  });

  // Pattern: archive a task → its linked ticket is voided.
  it("archive task → linked ticket status becomes void", async () => {
    // Create a task with a unit, so it auto-spawns a ticket.
    const taskRes = await createTaskService(CTX_A, {
      title: "Fix broken window",
      priority: "low",
      relatedUnitId: UNIT_A,
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.data;
    expect(task.ticketId).not.toBeNull();

    // Archive the task — should void the linked ticket.
    const archiveRes = await archiveTaskService(CTX_A, {
      taskId: task.id,
      updatedAt: task.updatedAt,
    });
    expect(archiveRes.ok).toBe(true);

    // Verify the ticket is now void.
    const ticketRes = await getTicketService(CTX_A, task.ticketId!);
    expect(ticketRes.ok).toBe(true);
    if (!ticketRes.ok) return;
    expect(ticketRes.data.status).toBe("void");
  });

  // Pattern: pulling a done ticket-linked task out of done reopens its ticket.
  it("move done ticket-linked task back to todo → task revives and ticket reopens", async () => {
    // Seed a ticket and let the service spawn the mirror task.
    const ticketRes = await createTicketService(CTX_A, {
      unitId: UNIT_A,
      title: "Electrical fault",
      warrantyFlag: false, priority: "medium",
    });
    expect(ticketRes.ok).toBe(true);
    if (!ticketRes.ok) return;
    const ticket = ticketRes.data;

    const taskListRes = await listTasksService(CTX_A, {});
    expect(taskListRes.ok).toBe(true);
    if (!taskListRes.ok) return;
    const mirrorTask = taskListRes.data.find((t) => t.ticketId === ticket.id);
    expect(mirrorTask).toBeDefined();

    // Resolve the ticket — this mirrors the task to done.
    const resolveRes = await resolveTicketService(CTX_A, {
      ticketId: ticket.id,
      updatedAt: ticket.updatedAt,
      entry: "Fixed wiring",
      attachmentKeys: [],
      occurredOn: "2026-06-22T10:00:00.000Z",
    });
    expect(resolveRes.ok).toBe(true);

    // Re-fetch the task to get its current updatedAt after the status mirror.
    const freshTask = await getTaskService(CTX_A, mirrorTask!.id);
    expect(freshTask.ok).toBe(true);
    if (!freshTask.ok) return;
    expect(freshTask.data.status).toBe("done");

    // Pull the done-linked task back to todo — the resolved ticket reopens.
    const moveRes = await moveTaskService(CTX_A, {
      taskId: freshTask.data.id,
      updatedAt: freshTask.data.updatedAt,
      status: "todo",
    });
    expect(moveRes.ok).toBe(true);
    if (!moveRes.ok) return;
    expect(moveRes.data.status).toBe("todo");
    expect(moveRes.data.completedAt).toBeNull();

    // todo lane → the ticket reopens to "open" with resolvedAt cleared, and the
    // reopen leaves a history note alongside resolve's entry.
    const reopened = await getTicketService(CTX_A, ticket.id);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.data.status).toBe("open");
    expect(reopened.data.resolvedAt).toBeNull();
    expect(reopened.data.historyCount).toBe(2);
  });
});
