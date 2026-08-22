// apps/api/src/lib/document-templates/repository.ts

import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { DocType, HeaderFieldFlags } from "./types";

export type DocumentTemplateRow = {
  id: string;
  organizationId: string;
  docType: string;
  title: string;
  refPrefix: string;
  refSeparator: string;
  refPadding: number;
  refIncludeYear: boolean;
  headerFields: HeaderFieldFlags;
  orgRegNo: string | null;
  orgSalesTaxId: string | null;
  orgServiceTaxId: string | null;
  orgAddressLines: string[];
  orgEmail: string | null;
  orgContact: string | null;
  logoKey: string | null;
  bodyTemplate?: string | null;
};

const DELEGATE = (db: Prisma.TransactionClient | ReturnType<typeof getDb>) =>
  db.documentTemplate;

export async function findTemplate(
  orgId: string,
  docType: DocType,
  client?: Prisma.TransactionClient,
): Promise<DocumentTemplateRow | null> {
  const db = client ?? getDb();
  const row = await DELEGATE(db).findUnique({
    where: { organizationId_docType: { organizationId: orgId, docType } },
  });
  if (!row) return null;
  return {
    ...row,
    headerFields: row.headerFields as unknown as HeaderFieldFlags,
    orgAddressLines: (row.orgAddressLines as unknown as string[]) ?? [],
  };
}

export async function upsertTemplate(
  orgId: string,
  docType: DocType,
  data: Omit<DocumentTemplateRow, "id" | "organizationId" | "docType">,
): Promise<DocumentTemplateRow> {
  const db = getDb();
  const row = await db.documentTemplate.upsert({
    where: { organizationId_docType: { organizationId: orgId, docType } },
    create: { organizationId: orgId, docType, ...data, bodyTemplate: data.bodyTemplate ?? null },
    update: { ...data, bodyTemplate: data.bodyTemplate ?? null },
  });
  return {
    ...row,
    headerFields: row.headerFields as unknown as HeaderFieldFlags,
    orgAddressLines: (row.orgAddressLines as unknown as string[]) ?? [],
  };
}

export async function listTemplates(orgId: string): Promise<DocumentTemplateRow[]> {
  const db = getDb();
  const rows = await db.documentTemplate.findMany({
    where: { organizationId: orgId },
    orderBy: { docType: "asc" },
  });
  return rows.map((r) => ({
    ...r,
    headerFields: r.headerFields as unknown as HeaderFieldFlags,
    orgAddressLines: (r.orgAddressLines as unknown as string[]) ?? [],
  }));
}

export async function findOrgName(orgId: string): Promise<string> {
  const db = getDb();
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { name: true },
  });
  return org.name;
}
