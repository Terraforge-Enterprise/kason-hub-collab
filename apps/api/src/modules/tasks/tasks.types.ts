import type { TaskPriority, TaskStatus, TicketStatus } from "@kason/shared";
import type { AdminRole } from "../../lib/rbac";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type TasksServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface TasksActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string | null;
  sortOrder: number | null;
  attachmentKeys: string[];
  assignee: { id: string; fullName: string; photoUrl: string | null } | null;
  relatedUnit: { id: string; unitCode: string; propertyName: string } | null;
  ticketId: string | null;
  sprintId: string | null;
  dueOn: string | null;
  startedAt: string | null;
  completedAt: string | null;
  assignedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TicketRow = {
  id: string;
  unitId: string;
  title: string;
  description: string | null;
  category: string | null;
  status: TicketStatus;
  warrantyFlag: boolean;
  attachmentKeys: string[];
  historyCount: number;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HistoryRow = {
  id: string;
  ticketId: string;
  unitId: string;
  entry: string;
  attachmentKeys: string[];
  actor: { id: string; fullName: string } | null;
  ticket: { id: string; title: string; status: TicketStatus } | null;
  occurredOn: string;
  createdAt: string;
};
