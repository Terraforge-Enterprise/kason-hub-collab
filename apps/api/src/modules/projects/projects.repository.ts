import { getDb, Prisma } from "@kason/db";
import type {
  CreateProjectInput,
  ListProjectsQuery,
  ProjectRow,
  UpdateProjectInput,
} from "./projects.types";

const PROJECT_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  developer: true,
  city: true,
  expectedHandover: true,
  status: true,
  promotedPropertyId: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const;

export async function listProjects(
  organizationId: string,
  filters?: ListProjectsQuery,
): Promise<ProjectRow[]> {
  const db = getDb();
  const q = filters?.q?.trim();
  const where: Prisma.ProjectWhereInput = {
    organizationId,
    ...(filters?.status ? { status: filters.status } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { developer: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  return db.project.findMany({
    where,
    select: PROJECT_SELECT,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
}

export async function findProjectById(
  organizationId: string,
  id: string,
): Promise<ProjectRow | null> {
  const db = getDb();
  return db.project.findFirst({
    where: { id, organizationId },
    select: PROJECT_SELECT,
  });
}

export async function findProjectByNameConflict(params: {
  organizationId: string;
  name: string;
  excludeId?: string;
}): Promise<{ id: string } | null> {
  const db = getDb();
  return db.project.findFirst({
    where: {
      organizationId: params.organizationId,
      name: params.name,
      ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
    },
    select: { id: true },
  });
}

export async function createProjectRow(
  tx: Prisma.TransactionClient,
  input: CreateProjectInput & {
    organizationId: string;
    createdById: string;
    statusOverride?: string;
  },
): Promise<ProjectRow> {
  return tx.project.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      developer: input.developer,
      city: input.city ?? null,
      expectedHandover: input.expectedHandover ? new Date(input.expectedHandover) : null,
      status: input.statusOverride ?? input.status ?? "active",
      notes: input.notes ?? null,
      createdById: input.createdById,
    },
    select: PROJECT_SELECT,
  });
}

export async function updateProjectRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
  input: UpdateProjectInput,
): Promise<ProjectRow> {
  const data: Prisma.ProjectUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.developer !== undefined) data.developer = input.developer;
  if (input.city !== undefined) data.city = input.city;
  if (input.expectedHandover !== undefined) {
    data.expectedHandover = input.expectedHandover ? new Date(input.expectedHandover) : null;
  }
  if (input.status !== undefined) data.status = input.status;
  if (input.notes !== undefined) data.notes = input.notes;

  // updateMany via composite-key shape would be safer here for org isolation,
  // but the caller (`updateProjectService`) re-reads inside the same tx via
  // `findProjectByIdTx` to lock down TOCTOU. The .update() targets {id} only,
  // which is fine because the in-tx ownership check already ran.
  return tx.project.update({
    where: { id, organizationId },
    data,
    select: PROJECT_SELECT,
  });
}

export async function findProjectByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<ProjectRow | null> {
  return tx.project.findFirst({
    where: { id, organizationId },
    select: PROJECT_SELECT,
  });
}

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}
