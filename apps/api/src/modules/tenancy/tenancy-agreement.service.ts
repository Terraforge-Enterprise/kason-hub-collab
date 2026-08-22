import { getDb } from "@kason/db";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import { renderToHtml } from "../../lib/document-templates/render";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import { createSignedDownloadUrl, putObject } from "../../lib/storage";
import type { TenancySession } from "./tenancy.types";
import {
  WHOLE_UNIT_TENANCY_AGREEMENT_TEMPLATE_NAME,
  WHOLE_UNIT_TENANCY_AGREEMENT_V432,
} from "./whole-unit-tenancy-agreement-template";

export const DEFAULT_AGREEMENT_BODY = `<section><h3>1. Parties</h3><p>This Tenancy Agreement is made between <strong>{{owner_name}}</strong> (ID: {{owner_id}}), the Landlord, and <strong>{{tenant_name}}</strong> (ID: {{tenant_id}}), the Tenant.</p></section>
<section><h3>2. Premises</h3><p>The Landlord lets to the Tenant the premises known as <strong>{{property_name}} {{unit_number}}</strong>, situated at {{property_address}}.</p></section>
<section><h3>3. Term</h3><p>The tenancy commences on <strong>{{start_date}}</strong> and ends on <strong>{{end_date}}</strong>.</p></section>
<section><h3>4. Rent</h3><p>The monthly rent is <strong>RM {{monthly_rent}}</strong>, payable in advance in accordance with the agreed payment schedule.</p></section>
<section><h3>5. Deposit</h3><p>The rental deposit is <strong>RM {{rental_deposit}}</strong>. Deposit money is refundable tenant money and is transferred to the Landlord for custody. On move-out, the Landlord shall refund the balance directly to the Tenant after agreed deductions for damage, unpaid charges or other liabilities.</p></section>
<section><h3>6. Utilities and Outgoings</h3><p>The Tenant shall pay all utilities and other charges allocated to the Tenant under this agreement. Owner-borne outgoings remain the Landlord's responsibility.</p></section>
<section><h3>7. Care and Use</h3><p>The Tenant shall keep the premises reasonably clean and in good condition, use it only for the agreed residential purpose, and promptly report damage or maintenance issues.</p></section>
<section><h3>8. Renewal and Termination</h3><p>Renewal is subject to written agreement. Notice, early termination and handover shall follow the agreed tenancy terms and applicable law.</p></section>
<section><h3>9. Special Conditions</h3><p>Add or amend special conditions here before generating the PDF.</p></section>
<section class="signature-section"><h3>Signatures</h3><p>Landlord: ____________________ &nbsp;&nbsp; Tenant: ____________________</p><p>Date: _______________________ &nbsp;&nbsp; Date: _______________________</p></section>`;

const esc = (v: unknown) => String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const date = (v: Date | null) => v ? new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }).format(v) : "—";
const upperDate = (v: Date) => date(v).toUpperCase();

function agreementValues(t: NonNullable<Awaited<ReturnType<typeof source>>>) {
  const today = new Date();
  const utilityDeposit = Number(t.monthlyRentAmount) * Number(t.unit.utilitiesDepositMonths ?? 0);
  const accessCardDeposit = Number(t.unit.accessCardDepositPerPcs ?? 0) * Number(t.unit.accessCardQuantity ?? 0);
  const durationMonths = t.termMonths ?? (t.endDate ? Math.max(1, Math.round((t.endDate.getTime() - t.startDate.getTime()) / (1000 * 60 * 60 * 24 * 30.4375))) : null);
  const tenancyDuration = durationMonths == null
    ? "—"
    : durationMonths % 12 === 0
      ? `${durationMonths / 12} ${durationMonths === 12 ? "YEAR" : "YEARS"}`
      : `${durationMonths} MONTHS`;
  return {
    tenancy_code: t.tenancyCode,
    tenant_name: t.tenantParty.legalName || t.tenantParty.displayName,
    tenant_id: t.tenantParty.idNumber || "",
    tenant_phone: t.tenantParty.primaryPhone || "",
    tenant_email: t.tenantParty.primaryEmail || "",
    owner_name: t.unit.ownerParty?.legalName || t.unit.ownerParty?.displayName || "",
    owner_id: t.unit.ownerParty?.idNumber || "",
    owner_phone: t.unit.ownerParty?.primaryPhone || "",
    owner_email: t.unit.ownerParty?.primaryEmail || "",
    property_name: t.property.name,
    unit_number: t.unit.apartment.unitCode,
    property_address: [t.unit.apartment.unitCode, t.property.name, t.property.addressLine1, t.property.addressLine2, t.property.postalCode, t.property.city, t.property.state, t.property.country].filter(Boolean).join(", "),
    agreement_date: upperDate(today),
    agreement_day: new Intl.DateTimeFormat("en-MY", { day: "numeric", timeZone: "Asia/Kuala_Lumpur" }).format(today),
    agreement_month_year: new Intl.DateTimeFormat("en-MY", { month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }).format(today).toUpperCase(),
    start_date: upperDate(t.startDate),
    end_date: t.endDate ? upperDate(t.endDate) : "—",
    tenancy_duration: tenancyDuration,
    monthly_rent: money(t.monthlyRentAmount),
    rental_deposit: money(t.depositAmount),
    utilities_deposit: money(utilityDeposit),
    access_card_deposit: money(accessCardDeposit),
    permitted_use: "Residential Only",
    rent_due_day: "seventh (7th)",
    payment_bank_name: "HONG LEONG BANK",
    payment_account_name: "KAEN PROPERTIES MANAGEMENT SDN BHD",
    payment_account_number: "11600078637",
    payment_email: "kaenproperties@gmail.com",
  };
}

async function source(orgId: string, tenancyId: string) {
  const db = getDb();
  return db.tenancy.findFirst({
    where: { id: tenancyId, organizationId: orgId },
    include: {
      tenantParty: true,
      property: true,
      unit: { include: { apartment: true, ownerParty: true } },
    },
  });
}

function merge(template: string, t: NonNullable<Awaited<ReturnType<typeof source>>>) {
  const values = Object.fromEntries(Object.entries(agreementValues(t)).map(([key, value]) => [key, esc(value)])) as Record<string, string>;
  return template.replace(/{{\s*([a-z_]+)\s*}}/g, (_, key: string) => values[key] ?? `{{${key}}}`);
}

function sourceFields(t: NonNullable<Awaited<ReturnType<typeof source>>>) {
  return agreementValues(t);
}

function renderAgreementDocument(
  template: Awaited<ReturnType<typeof getTemplateForOrgDocType>>,
  referenceCode: string,
  issuedDate: Date,
  bodyHtml: string,
) {
  // The supplied v4.32 agreement is a complete legal document with its own
  // Letter page geometry, cover and pagination. Do not prepend the generic
  // KAEN invoice/document header, as that shifts every Word-derived page.
  if (bodyHtml.includes("data-word-template-style")) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(referenceCode)}</title></head><body>${bodyHtml}</body></html>`;
  }
  return renderToHtml({ template, referenceCode, issuedDate, bodyHtml });
}

export async function getOrCreateAgreement(session: TenancySession, tenancyId: string) {
  const db = getDb();
  const tenancy = await source(session.orgId, tenancyId);
  if (!tenancy) return null;
  const existing = await db.tenancyAgreement.findFirst({ where: { organizationId: session.orgId, tenancyId, status: { in: ["draft", "ready_review", "approved"] } }, orderBy: { version: "desc" } });
  if (existing) return { ...existing, previewHtml: merge(existing.contentHtml, tenancy), fields: sourceFields(tenancy) };
  const latest = await db.tenancyAgreement.findFirst({ where: { organizationId: session.orgId, tenancyId }, orderBy: { version: "desc" } });
  const selected = await db.tenancyAgreementTemplate.findFirst({ where: { organizationId: session.orgId, active: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const legacy = await getTemplateForOrgDocType(session.orgId, "tenancy_agreement", { tolerateLogoFailure: true });
  const created = await db.tenancyAgreement.create({ data: { organizationId: session.orgId, tenancyId, version: (latest?.version ?? 0) + 1, templateId: selected?.id ?? null, contentHtml: selected?.contentHtml || legacy.bodyTemplate || DEFAULT_AGREEMENT_BODY } });
  return { ...created, previewHtml: merge(created.contentHtml, tenancy), fields: sourceFields(tenancy) };
}

export async function updateAgreement(session: TenancySession, agreementId: string, contentHtml: string) {
  const db = getDb();
  const row = await db.tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId, status: "draft" } });
  if (!row) return null;
  return db.tenancyAgreement.update({ where: { id: row.id }, data: { contentHtml } });
}

const AGREEMENT_TRANSITIONS: Record<string, string[]> = {
  draft: ["ready_review"],
  ready_review: ["draft", "approved"],
  approved: ["draft"],
  generated: ["sent_for_signature", "signed"],
  sent_for_signature: ["signed"],
};
const REVIEW_REQUIRED_FIELDS = ["owner_name", "owner_id", "tenant_name", "tenant_id", "property_address", "start_date", "end_date", "monthly_rent", "rental_deposit", "payment_bank_name", "payment_account_number"] as const;

export async function transitionAgreement(session: TenancySession, agreementId: string, nextStatus: string) {
  const db = getDb();
  const row = await db.tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId } });
  if (!row || !AGREEMENT_TRANSITIONS[row.status]?.includes(nextStatus)) return null;
  if (["ready_review", "approved"].includes(nextStatus)) {
    const tenancy = await source(session.orgId, row.tenancyId);
    if (!tenancy) return null;
    const values = agreementValues(tenancy);
    if (REVIEW_REQUIRED_FIELDS.some((key) => !String(values[key] ?? "").trim() || String(values[key]).trim() === "—")) return null;
  }
  return db.tenancyAgreement.update({ where: { id: row.id }, data: { status: nextStatus } });
}

export async function generateAgreement(session: TenancySession, agreementId: string) {
  const db = getDb();
  const row = await db.tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId, status: "approved" }, include: { tenancy: { include: { property: true, unit: { include: { apartment: true, ownerParty: true } }, tenantParty: true } } } });
  if (!row) return null;
  const template = await getTemplateForOrgDocType(session.orgId, "tenancy_agreement");
  const html = renderAgreementDocument(template, `${row.tenancy.tenancyCode}-V${row.version}`, new Date(), merge(row.contentHtml, row.tenancy));
  const pdf = await htmlToPdf(html);
  const tenancyPeriod = `${upperDate(row.tenancy.startDate)}${row.tenancy.endDate ? ` TO ${upperDate(row.tenancy.endDate)}` : ""}`;
  const safe = `${row.tenancy.property.name} ${row.tenancy.unit.apartment.unitCode} ${row.tenancy.tenantParty.displayName} ${tenancyPeriod}`.replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, " ").trim().toUpperCase();
  const fileName = `TENANCY AGREEMENT ${safe}.pdf`;
  const pdfKey = `tenancy-agreements/${session.orgId}/${row.tenancyId}/${row.id}-v${row.version}.pdf`;
  await putObject(pdfKey, pdf, "application/pdf");
  const generated = await db.$transaction(async (tx) => {
    await tx.tenancyAgreement.updateMany({ where: { organizationId: session.orgId, tenancyId: row.tenancyId, status: { in: ["generated", "sent_for_signature", "signed"] } }, data: { status: "superseded" } });
    const agreement = await tx.tenancyAgreement.update({ where: { id: row.id }, data: { status: "generated", fileName, pdfKey, generatedAt: new Date(), generatedById: session.userId } });
    const document = await tx.document.create({ data: { organizationId: session.orgId, fileName, fileType: "application/pdf", fileSize: pdf.length, storageKey: pdfKey, uploadedBy: session.userId } });
    await tx.documentLink.create({ data: { organizationId: session.orgId, documentId: document.id, linkedEntityType: "tenancy", linkedEntityId: row.tenancyId, label: `Tenancy Agreement · ${row.tenancy.tenancyCode} · Version ${row.version}` } });
    return agreement;
  });
  return { ...generated, downloadUrl: await createSignedDownloadUrl(pdfKey) };
}

export async function listAgreementTemplates(session: TenancySession) {
  const db = getDb();
  const count = await db.tenancyAgreementTemplate.count({ where: { organizationId: session.orgId } });
  if (count === 0) await db.tenancyAgreementTemplate.create({ data: { organizationId: session.orgId, name: "Standard Residential Tenancy", description: "Default KAEN residential tenancy agreement", contentHtml: DEFAULT_AGREEMENT_BODY, isDefault: true } });
  const supplied = await db.tenancyAgreementTemplate.findFirst({ where: { organizationId: session.orgId, name: WHOLE_UNIT_TENANCY_AGREEMENT_TEMPLATE_NAME } });
  if (!supplied) {
    await db.tenancyAgreementTemplate.create({
      data: {
        organizationId: session.orgId,
        name: WHOLE_UNIT_TENANCY_AGREEMENT_TEMPLATE_NAME,
        description: "Editable 14-page whole-unit agreement recreated from the supplied v4.32 Word template",
        contentHtml: WHOLE_UNIT_TENANCY_AGREEMENT_V432,
        isDefault: false,
      },
    });
  } else if (!supplied.contentHtml.includes('data-word-template-style="v4.32-fidelity-3"')) {
    // One-time upgrade from the earlier hand-recreated/incorrectly paginated
    // draft to the verified Microsoft Word export. Once this version is in the
    // database, later user edits are left alone.
    await db.tenancyAgreementTemplate.update({
      where: { id: supplied.id },
      data: {
        description: "Faithful editable export of the supplied 14-page v4.32 Word template",
        contentHtml: WHOLE_UNIT_TENANCY_AGREEMENT_V432,
      },
    });
  }
  return db.tenancyAgreementTemplate.findMany({ where: { organizationId: session.orgId, active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
}

export async function saveAgreementTemplate(session: TenancySession, input: { id?: string; name: string; description?: string; contentHtml: string; isDefault?: boolean }) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    if (input.isDefault) await tx.tenancyAgreementTemplate.updateMany({ where: { organizationId: session.orgId }, data: { isDefault: false } });
    return input.id
      ? tx.tenancyAgreementTemplate.update({ where: { id: input.id, organizationId: session.orgId }, data: { name: input.name, description: input.description || null, contentHtml: input.contentHtml, isDefault: !!input.isDefault } })
      : tx.tenancyAgreementTemplate.create({ data: { organizationId: session.orgId, name: input.name, description: input.description || null, contentHtml: input.contentHtml, isDefault: !!input.isDefault } });
  });
}

export async function applyAgreementTemplate(session: TenancySession, agreementId: string, templateId: string) {
  const db = getDb();
  const [agreement, template] = await Promise.all([
    db.tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId, status: { in: ["draft", "ready_review", "approved"] } } }),
    db.tenancyAgreementTemplate.findFirst({ where: { id: templateId, organizationId: session.orgId, active: true } }),
  ]);
  if (!agreement || !template) return null;
  return db.tenancyAgreement.update({ where: { id: agreement.id }, data: { templateId: template.id, contentHtml: template.contentHtml } });
}

export async function previewAgreement(session: TenancySession, agreementId: string, contentHtml: string) {
  const row = await getDb().tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId } });
  if (!row) return null;
  const tenancy = await source(session.orgId, row.tenancyId);
  return tenancy ? merge(contentHtml, tenancy) : null;
}

export async function previewAgreementPdf(session: TenancySession, agreementId: string, contentHtml: string) {
  const db = getDb();
  const row = await db.tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId } });
  if (!row) return null;
  const tenancy = await source(session.orgId, row.tenancyId);
  if (!tenancy) return null;
  const template = await getTemplateForOrgDocType(session.orgId, "tenancy_agreement");
  const pdf = await htmlToPdf(renderAgreementDocument(template, `${tenancy.tenancyCode}-PREVIEW`, new Date(), merge(contentHtml, tenancy)));
  // Preview must work even when object storage is unavailable or has not been
  // configured in a local/UAT environment.  Return the temporary PDF inline;
  // only the final Generate action persists a document to storage.
  return {
    fileName: `TENANCY AGREEMENT ${tenancy.property.name} ${tenancy.unit.apartment.unitCode} PREVIEW.pdf`,
    contentBase64: pdf.toString("base64"),
  };
}

export async function agreementHistory(session: TenancySession, tenancyId: string) {
  return getDb().tenancyAgreement.findMany({ where: { organizationId: session.orgId, tenancyId }, orderBy: { version: "desc" } });
}

export async function agreementDownload(session: TenancySession, agreementId: string) {
  const row = await getDb().tenancyAgreement.findFirst({ where: { id: agreementId, organizationId: session.orgId } });
  if (!row?.pdfKey) return null;
  return { fileName: row.fileName!, downloadUrl: await createSignedDownloadUrl(row.pdfKey) };
}
