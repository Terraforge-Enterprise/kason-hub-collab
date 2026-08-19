import { getDb, type Prisma } from "@kason/db";
import type {
  LabelCategory,
  SettingsLabelRow,
} from "./renovation-settings.types";

const LABEL_SELECT = {
  id: true,
  organizationId: true,
  category: true,
  key: true,
  label: true,
  sortOrder: true,
} as const;

type RawLabel = {
  id: string;
  organizationId: string;
  category: string;
  key: string;
  label: string;
  sortOrder: number;
};

function mapLabel(row: RawLabel): SettingsLabelRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    // The DB column is `string` (open-ended), but every row we surface is
    // bound to one of the four enum values via the Zod-validated writes.
    category: row.category as LabelCategory,
    key: row.key,
    label: row.label,
    sortOrder: row.sortOrder,
  };
}

/**
 * Single fetch of every label in the org, sorted by `sortOrder` ASC then
 * `key` ASC for stable output. The service groups the rows into the
 * frontend-cache shape; the repo stays thin.
 */
export async function listLabels(
  organizationId: string,
): Promise<SettingsLabelRow[]> {
  const db = getDb();
  const rows = await db.settingsLabel.findMany({
    where: { organizationId },
    select: LABEL_SELECT,
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });
  return (rows as unknown as RawLabel[]).map(mapLabel);
}

export async function findLabelById(
  organizationId: string,
  id: string,
): Promise<SettingsLabelRow | null> {
  const db = getDb();
  const row = await db.settingsLabel.findFirst({
    where: { id, organizationId },
    select: LABEL_SELECT,
  });
  if (!row) return null;
  return mapLabel(row as unknown as RawLabel);
}

export async function findLabelByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<SettingsLabelRow | null> {
  const row = await tx.settingsLabel.findFirst({
    where: { id, organizationId },
    select: LABEL_SELECT,
  });
  if (!row) return null;
  return mapLabel(row as unknown as RawLabel);
}

/**
 * Conflict-check on the unique tuple `(organizationId, category, key)`.
 * Returns the conflicting row's id (or null). Used by the service before
 * insert to convert a Prisma P2002 into a clean 409.
 */
export async function findLabelByCategoryKeyConflict(params: {
  organizationId: string;
  category: LabelCategory;
  key: string;
}): Promise<{ id: string } | null> {
  const db = getDb();
  return db.settingsLabel.findFirst({
    where: {
      organizationId: params.organizationId,
      category: params.category,
      key: params.key,
    },
    select: { id: true },
  });
}

export async function createLabelRow(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    category: LabelCategory;
    key: string;
    label: string;
    sortOrder: number;
  },
): Promise<SettingsLabelRow> {
  const row = await tx.settingsLabel.create({
    data: {
      organizationId: input.organizationId,
      category: input.category,
      key: input.key,
      label: input.label,
      sortOrder: input.sortOrder,
    },
    select: LABEL_SELECT,
  });
  return mapLabel(row as unknown as RawLabel);
}

export async function updateLabelRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
  input: {
    label?: string;
    sortOrder?: number;
  },
): Promise<SettingsLabelRow> {
  // Scope by organizationId as defence-in-depth — the service pre-checks
  // ownership today, but updateMany prevents cross-org writes if a future
  // refactor bypasses that check.
  await tx.settingsLabel.updateMany({
    where: { id, organizationId },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });
  const row = await tx.settingsLabel.findFirst({
    where: { id, organizationId },
    select: LABEL_SELECT,
  });
  // Caller has already verified the row exists; if it disappeared mid-tx
  // the transaction will rewind and surface the underlying error.
  if (!row) {
    throw new Error("SettingsLabel vanished during update");
  }
  return mapLabel(row as unknown as RawLabel);
}

export async function deleteLabelRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
): Promise<void> {
  await tx.settingsLabel.deleteMany({
    where: { id, organizationId },
  });
}

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}
