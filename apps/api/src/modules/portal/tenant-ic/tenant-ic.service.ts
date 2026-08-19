import { randomUUID } from "node:crypto";

const BUCKET = "tenant-ic";
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/heic"] as const;
const ALLOWED_SIDES = ["front", "back"] as const;
const RATE_LIMIT_WINDOW_HOURS = 1;
const RATE_LIMIT_MAX = 30;

type Side = (typeof ALLOWED_SIDES)[number];
type ContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export type Session = { partyId: string; orgId: string; role: string };

type PendingUploadDelegate = {
  create(args: { data: any }): Promise<any>;
  count(args: { where: any }): Promise<number>;
  findFirst(args: { where: any; select?: any }): Promise<any | null>;
  update(args: { where: any; data: any }): Promise<any>;
  updateMany(args: { where: any; data: any }): Promise<{ count: number }>;
};

type IcAccessLogDelegate = { create(args: { data: any }): Promise<any> };
type UserDelegate = { findFirst(args: { where: any; select?: any }): Promise<any | null> };
type CommissionClaimItemDelegate = { findFirst(args: { where: any; select?: any }): Promise<any | null> };

type PrismaLike = {
  pendingUpload: PendingUploadDelegate;
  icAccessLog?: IcAccessLogDelegate;
  user?: UserDelegate;
  commissionClaimItem?: CommissionClaimItemDelegate;
};

export class IcServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requestUploadUrl(deps: {
  prisma: PrismaLike;
  signSupabaseUpload: (key: string) => Promise<{
    uploadUrl: string;
    method: string;
    headers: Record<string, string>;
    expiresAt: Date;
  }>;
  session: Session;
  side: Side;
  contentType: ContentType;
}): Promise<{
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  storageKey: string;
  expiresAt: Date;
}> {
  if (!ALLOWED_CONTENT_TYPES.includes(deps.contentType)) {
    throw new IcServiceError(400, `Invalid contentType: ${deps.contentType}`);
  }
  if (!ALLOWED_SIDES.includes(deps.side)) {
    throw new IcServiceError(400, `Invalid side: ${deps.side}`);
  }

  // Rate limit — count pending+consumed in the last hour for this party.
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000);
  const recent = await deps.prisma.pendingUpload.count({
    where: {
      organizationId: deps.session.orgId,
      partyId: deps.session.partyId,
      createdAt: { gte: since },
    },
  });
  if (recent >= RATE_LIMIT_MAX) {
    throw new IcServiceError(429, "Too many uploads — please retry in an hour.");
  }

  const ext = deps.contentType.split("/")[1].replace("jpeg", "jpeg");   // jpeg/png/heic
  const dirUuid = randomUUID();
  const fileUuid = randomUUID();
  const storageKey = `${BUCKET}/${deps.session.orgId}/${deps.session.partyId}/temp/${dirUuid}/${deps.side}-${fileUuid}.${ext}`;

  const { uploadUrl, method, headers, expiresAt } = await deps.signSupabaseUpload(storageKey);

  await deps.prisma.pendingUpload.create({
    data: {
      organizationId: deps.session.orgId,
      partyId: deps.session.partyId,
      storageKey,
      bucket: BUCKET,
      uploadType: "tenant_ic",
      side: deps.side,
      contentType: deps.contentType,
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  return { uploadUrl, method, headers, storageKey, expiresAt };
}

export async function deleteUpload(deps: {
  prisma: PrismaLike;
  deleteObject: (bucket: string, key: string) => Promise<void>;
  // The object lives in the configured bucket (requireBucket()); the stored
  // PendingUpload.bucket ("tenant-ic") is informational only (a key prefix).
  bucket: string;
  session: Session;
  storageKey: string;
}): Promise<void> {
  // Defence-in-depth: the path MUST begin with tenant-ic/<org>/<party>/.
  const expectedPrefix = `${BUCKET}/${deps.session.orgId}/${deps.session.partyId}/`;
  if (!deps.storageKey.startsWith(expectedPrefix)) {
    throw new IcServiceError(404, "Not found");
  }
  const row = await deps.prisma.pendingUpload.findFirst({
    where: {
      storageKey: deps.storageKey,
      partyId: deps.session.partyId,
      organizationId: deps.session.orgId,
    },
    select: { id: true, status: true, bucket: true, storageKey: true },
  });
  if (!row) throw new IcServiceError(404, "Not found");
  if (row.status === "consumed") throw new IcServiceError(409, "Already consumed");
  if (row.status !== "pending") throw new IcServiceError(404, "Not found");

  await deps.deleteObject(deps.bucket, row.storageKey);
  await deps.prisma.pendingUpload.update({
    where: { id: row.id },
    data: { status: "deleted" },
  });
}

const ADMIN_ROLES = ["admin", "manager"] as const;

export async function viewUrlForAgent(deps: {
  prisma: PrismaLike;
  signSupabaseView: (key: string) => Promise<{ viewUrl: string; expiresAt: Date }>;
  session: Session;
  storageKey: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ viewUrl: string; expiresAt: Date }> {
  const expectedPrefix = `${BUCKET}/${deps.session.orgId}/${deps.session.partyId}/`;
  if (!deps.storageKey.startsWith(expectedPrefix)) {
    throw new IcServiceError(404, "Not found");
  }
  const row = await deps.prisma.pendingUpload.findFirst({
    where: { storageKey: deps.storageKey, partyId: deps.session.partyId, organizationId: deps.session.orgId },
    select: { id: true, side: true, consumedClaimItemId: true },
  });
  if (!row) throw new IcServiceError(404, "Not found");

  // Resolve agent's User row to attribute the audit log.
  const user = await deps.prisma.user!.findFirst({
    where: { partyId: deps.session.partyId, organizationId: deps.session.orgId },
    select: { id: true },
  });

  const result = await deps.signSupabaseView(deps.storageKey);

  if (user && row.side) {
    await deps.prisma.icAccessLog!.create({
      data: {
        organizationId: deps.session.orgId,
        claimItemId: row.consumedClaimItemId,
        side: row.side,
        viewerUserId: user.id,
        viewerScope: "agent_self",
        ip: deps.ip,
        userAgent: deps.userAgent,
      },
    });
  }

  return result;
}

export const TENANT_IC_BUCKET = BUCKET;

export async function markIcKeysConsumed(deps: {
  tx: PrismaLike;
  objectExists: (bucket: string, key: string) => Promise<boolean>;
  keys: string[];
  partyId: string;
  organizationId: string;
  claimItemId: string;
}): Promise<void> {
  if (deps.keys.length === 0) return;
  for (const key of deps.keys) {
    const exists = await deps.objectExists(BUCKET, key);
    if (!exists) {
      throw new IcServiceError(400, `Uploaded IC not found in storage: ${key}`);
    }
  }
  const result = await deps.tx.pendingUpload.updateMany({
    where: {
      storageKey: { in: deps.keys },
      partyId: deps.partyId,
      organizationId: deps.organizationId,
      status: "pending",
    },
    data: { status: "consumed", consumedClaimItemId: deps.claimItemId },
  });
  if (result.count !== deps.keys.length) {
    throw new IcServiceError(400, `IC promotion count mismatch — expected ${deps.keys.length}, updated ${result.count}`);
  }
}

export async function viewUrlForAdmin(deps: {
  prisma: PrismaLike;
  signSupabaseView: (key: string) => Promise<{ viewUrl: string; expiresAt: Date }>;
  session: Session & { userId: string };
  claimItemId: string;
  side: "front" | "back";
  ip: string | null;
  userAgent: string | null;
}): Promise<{ viewUrl: string; expiresAt: Date }> {
  if (!ADMIN_ROLES.includes(deps.session.role as any)) {
    throw new IcServiceError(403, "Forbidden");
  }
  const item = await deps.prisma.commissionClaimItem!.findFirst({
    where: { id: deps.claimItemId, organizationId: deps.session.orgId },
    select: { id: true, organizationId: true, tenantIcFrontKey: true, tenantIcBackKey: true },
  });
  if (!item) throw new IcServiceError(404, "Not found");
  const key = deps.side === "front" ? item.tenantIcFrontKey : item.tenantIcBackKey;
  if (!key) throw new IcServiceError(404, "Not found");

  const result = await deps.signSupabaseView(key);
  await deps.prisma.icAccessLog!.create({
    data: {
      organizationId: deps.session.orgId,
      claimItemId: item.id,
      side: deps.side,
      viewerUserId: deps.session.userId,
      viewerScope: "admin",
      ip: deps.ip,
      userAgent: deps.userAgent,
    },
  });
  return result;
}
