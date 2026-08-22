import { getDb } from "@kason/db";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import { renderToHtml } from "../../lib/document-templates/render";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import { createSignedDownloadUrl, putObject } from "../../lib/storage";
import type { TenancySession } from "./tenancy.types";

export const CAPPED_250_MANAGEMENT_TEMPLATE = `<div class="agreement-cover"><p>Dated on {{agreement_date}}</p><h3>BETWEEN</h3><p><strong>{{owner_name}}</strong><br>(NRIC / Company No. {{owner_id}})<br>(The Owner)</p><h3>AND</h3><p><strong>KAEN PROPERTIES MANAGEMENT SDN BHD</strong><br>(Company No. 1610050-V)<br>(The Operator)</p><h1>PROPERTY MANAGEMENT AGREEMENT</h1></div>
<section><h2>PROPERTY MANAGEMENT AGREEMENT</h2><p>An Agreement made on {{agreement_date}} between <strong>{{owner_name}}</strong> (the Owner) and <strong>KAEN PROPERTIES MANAGEMENT SDN BHD</strong> (the Operator).</p><p>The Owner is the beneficial and/or registered owner of the property described in the First Schedule (the Parcel) and appoints the Operator to market, promote, manage, rent and operate the Parcel subject to this Agreement.</p></section>
<section><h3>1. Interpretation</h3><p>Month means a Gregorian calendar month. Party means the Owner or the Operator and Parties means both. Property means {{property_name}}, {{property_address}}.</p></section>
<section><h3>2. Term of Appointment</h3><p>The appointment commences on {{commencement_date}} for {{first_tenure}}. Unless either Party serves three months' written notice before expiry, it renews for {{renewed_tenure}} on the same terms, subject to any agreed management fee revision.</p></section>
<section><h3>3. Authority of the Operator</h3><ol><li>Collect rents and additional charges from tenants.</li><li>Deduct compensation due to the Operator.</li><li>Pay utilities and Owner expenses from available Owner funds.</li><li>Prepare, amend, renew and terminate tenancies on the Owner's behalf.</li><li>Negotiate tenant disputes and coordinate lawful recovery or eviction action.</li><li>Inspect the Parcel and coordinate approved maintenance.</li></ol></section>
<section><h3>4. Service Management Fees and E-Invoice</h3><p>The Owner shall pay a service management fee capped at <strong>RM {{management_fee_cap}}</strong> per month, commencing when the first tenant moves into the Parcel. The fee is subject to {{sst_rate}}% SST, borne by the Owner.</p><p>The Operator may deduct management fees, reimbursements and other agreed charges from gross collections before remitting the balance to the Owner.</p><p>Where agreed, the first month's rent or booking fee is payable to the Operator as tenancy-placement commission and is subject to {{sst_rate}}% SST borne by the Owner.</p></section>
<section><h3>5. Utilities and Expenses</h3><p>Utilities, cleaning, repairs, maintenance, subscriptions and related operating expenses shall be allocated according to the applicable tenancy arrangement. Amounts not recoverable from tenants remain the Owner's responsibility. The Operator is not required to pay more than the rental collections or Owner funds available.</p></section>
<section><h3>6. Maintenance</h3><p>With the Owner's approval, the Operator may appoint contractors at the Owner's expense. In an emergency, the Operator may act without prior approval to prevent interruption of essential services, serious damage or bodily harm, and shall provide available supporting documentation.</p></section>
<section><h3>7. Liability and Indemnification</h3><p>Neither Party is liable for the other Party's negligence, breach or wilful misconduct. Each Party shall indemnify the other against loss caused by its own negligence, breach or wilful misconduct, subject to applicable law.</p></section>
<section><h3>8. Owner Representations and Responsibilities</h3><p>The Owner shall provide documents, disclosures, keys and access reasonably required to manage the Parcel, notify the Operator of material financing or legal issues affecting it, and shall not appoint another manager whose term overlaps this Agreement.</p></section>
<section><h3>9. Deposits</h3><p>All tenancy deposits collected are transferred to the Owner for custody. The Owner is responsible for refunding the balance directly to the tenant no later than 30 days after move-out, after agreed deductions. The Operator shall maintain a clear transactional record.</p></section>
<section><h3>10. Legal</h3><p>The Owner authorises the Operator to issue tenant notices and coordinate lawful proceedings required to enforce a tenancy. Attendance or records requested for legal proceedings may be charged at RM150 per hour with the Owner's consent.</p></section>
<section><h3>11. Default and Termination</h3><p>Either Party may terminate by giving three months' written notice. Insufficient notice may result in compensation equivalent to three months of management fees, subject to the terms agreed by the Parties.</p></section>
<section><h3>12. Force Majeure</h3><p>Neither Party shall be liable for delay caused by events beyond reasonable control, provided reasonable efforts are made to resume performance.</p></section>
<section><h2>FIRST SCHEDULE</h2><table><tbody><tr><th>Agreement date</th><td>{{agreement_date}}</td></tr><tr><th>Owner</th><td>{{owner_name}}<br>{{owner_id}}<br>{{owner_phone}}<br>{{owner_email}}<br>{{owner_bank_name}} · {{owner_bank_account}} · {{owner_bank_holder}}</td></tr><tr><th>Operator</th><td>KAEN PROPERTIES MANAGEMENT SDN BHD<br>Company No. 1610050-V</td></tr><tr><th>Property</th><td>{{property_name}}<br>{{property_address}}<br>Storey / Parcel / Car Park: {{parcel_details}}</td></tr><tr><th>Commencement date</th><td>{{commencement_date}}</td></tr><tr><th>First tenure</th><td>{{first_tenure}}</td></tr><tr><th>Renewed tenure</th><td>{{renewed_tenure}}</td></tr></tbody></table></section>
<section class="signature-section"><h2>SIGNATURES</h2><p>For KAEN PROPERTIES MANAGEMENT SDN BHD<br><br>Signature: ____________________ &nbsp; Name: KASON KHOO</p><p>Owner<br><br>Signature: ____________________ &nbsp; Name: {{owner_name}} &nbsp; NRIC: {{owner_id}}</p></section>`;

const esc = (v: unknown) => String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const date = (v: Date | null) => v ? new Intl.DateTimeFormat("en-MY", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }).format(v) : "—";

async function source(orgId: string, id: string) {
  return getDb().landlordTenancy.findFirst({ where: { id, organizationId: orgId }, include: { landlord: true, property: true } });
}

function merge(html: string, row: NonNullable<Awaited<ReturnType<typeof source>>>) {
  const months = row.endDate ? Math.max(1, Math.round((row.endDate.getTime() - row.startDate.getTime()) / 2_629_746_000)) : 12;
  const values: Record<string, string> = {
    agreement_date: date(new Date()), owner_name: esc(row.landlord.legalName || row.landlord.displayName), owner_id: esc(row.landlord.idNumber), owner_phone: esc(row.landlord.primaryPhone), owner_email: esc(row.landlord.primaryEmail),
    owner_bank_name: esc(row.landlord.bankName), owner_bank_account: esc(row.landlord.bankAccountNumber), owner_bank_holder: esc(row.landlord.bankAccountHolder), property_name: esc(row.property.name),
    property_address: esc([row.property.addressLine1, row.property.addressLine2, row.property.postalCode, row.property.city, row.property.state, row.property.country].filter(Boolean).join(", ")), commencement_date: date(row.startDate),
    first_tenure: `${months} months`, renewed_tenure: "12 months", management_fee_cap: "250.00", sst_rate: "8", parcel_details: "Add or edit parcel details before generating",
  };
  return html.replace(/{{\s*([a-z_]+)\s*}}/g, (_, key: string) => values[key] ?? `{{${key}}}`);
}

export async function listManagementTemplates(session: TenancySession) {
  const db = getDb();
  const sampleName = "Template E - Capped RM250 Property Management Agreement";
  const suppliedSample = await db.propertyManagementAgreementTemplate.findFirst({
    where: { organizationId: session.orgId, name: { in: [sampleName, "Capped RM250 Property Management Agreement"] } },
  });
  if (!suppliedSample) {
    await db.propertyManagementAgreementTemplate.create({ data: { organizationId: session.orgId, name: sampleName, description: "Recreated from the supplied 11-page KAEN owner-management agreement · capped RM250 · 8% SST", contentHtml: CAPPED_250_MANAGEMENT_TEMPLATE, isDefault: true } });
  } else if (suppliedSample.name !== sampleName) {
    await db.propertyManagementAgreementTemplate.update({ where: { id: suppliedSample.id }, data: { name: sampleName, description: "Recreated from the supplied 11-page KAEN owner-management agreement · capped RM250 · 8% SST" } });
  }
  return db.propertyManagementAgreementTemplate.findMany({ where: { organizationId: session.orgId, active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
}

export async function saveManagementTemplate(session: TenancySession, input: { id?: string; name: string; description?: string; contentHtml: string; isDefault?: boolean }) {
  return getDb().$transaction(async (tx) => {
    if (input.isDefault) await tx.propertyManagementAgreementTemplate.updateMany({ where: { organizationId: session.orgId }, data: { isDefault: false } });
    return input.id ? tx.propertyManagementAgreementTemplate.update({ where: { id: input.id, organizationId: session.orgId }, data: { name: input.name, description: input.description || null, contentHtml: input.contentHtml, isDefault: !!input.isDefault } }) : tx.propertyManagementAgreementTemplate.create({ data: { organizationId: session.orgId, name: input.name, description: input.description || null, contentHtml: input.contentHtml, isDefault: !!input.isDefault } });
  });
}

export async function getOrCreateManagementAgreement(session: TenancySession, landlordTenancyId: string) {
  const db = getDb(); const relation = await source(session.orgId, landlordTenancyId); if (!relation) return null;
  const current = await db.propertyManagementAgreement.findFirst({ where: { organizationId: session.orgId, landlordTenancyId, status: "draft" }, orderBy: { version: "desc" } });
  if (current) return { ...current, previewHtml: merge(current.contentHtml, relation) };
  const latest = await db.propertyManagementAgreement.findFirst({ where: { organizationId: session.orgId, landlordTenancyId }, orderBy: { version: "desc" } });
  const template = await db.propertyManagementAgreementTemplate.findFirst({ where: { organizationId: session.orgId, active: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const created = await db.propertyManagementAgreement.create({ data: { organizationId: session.orgId, landlordTenancyId, version: (latest?.version ?? 0) + 1, templateId: template?.id, contentHtml: template?.contentHtml ?? CAPPED_250_MANAGEMENT_TEMPLATE } });
  return { ...created, previewHtml: merge(created.contentHtml, relation) };
}

export async function managementHistory(session: TenancySession, landlordTenancyId: string) { return getDb().propertyManagementAgreement.findMany({ where: { organizationId: session.orgId, landlordTenancyId }, orderBy: { version: "desc" } }); }
export async function updateManagementAgreement(session: TenancySession, id: string, contentHtml: string) { const db = getDb(); const row = await db.propertyManagementAgreement.findFirst({ where: { id, organizationId: session.orgId, status: "draft" } }); return row ? db.propertyManagementAgreement.update({ where: { id: row.id }, data: { contentHtml } }) : null; }
export async function applyManagementTemplate(session: TenancySession, id: string, templateId: string) { const db = getDb(); const [row, template] = await Promise.all([db.propertyManagementAgreement.findFirst({ where: { id, organizationId: session.orgId, status: "draft" } }), db.propertyManagementAgreementTemplate.findFirst({ where: { id: templateId, organizationId: session.orgId, active: true } })]); return row && template ? db.propertyManagementAgreement.update({ where: { id: row.id }, data: { templateId, contentHtml: template.contentHtml } }) : null; }
export async function previewManagementAgreement(session: TenancySession, id: string, html: string) { const row = await getDb().propertyManagementAgreement.findFirst({ where: { id, organizationId: session.orgId } }); if (!row) return null; const relation = await source(session.orgId, row.landlordTenancyId); return relation ? merge(html, relation) : null; }

export async function previewManagementAgreementPdf(session: TenancySession, id: string, html: string) {
  const row = await getDb().propertyManagementAgreement.findFirst({ where: { id, organizationId: session.orgId } });
  if (!row) return null;
  const relation = await source(session.orgId, row.landlordTenancyId);
  if (!relation) return null;
  const shell = await getTemplateForOrgDocType(session.orgId, "property_management_agreement");
  const pdf = await htmlToPdf(renderToHtml({ template: shell, referenceCode: `PMA-PREVIEW-${row.id.slice(0, 8).toUpperCase()}`, issuedDate: new Date(), bodyHtml: merge(html, relation) }));
  return { fileName: `PROPERTY MANAGEMENT AGREEMENT ${relation.property.name} PREVIEW.pdf`, contentBase64: pdf.toString("base64") };
}

export async function generateManagementAgreement(session: TenancySession, id: string) {
  const db = getDb(); const row = await db.propertyManagementAgreement.findFirst({ where: { id, organizationId: session.orgId, status: "draft" } }); if (!row) return null;
  const relation = await source(session.orgId, row.landlordTenancyId); if (!relation) return null;
  const shell = await getTemplateForOrgDocType(session.orgId, "property_management_agreement");
  const pdf = await htmlToPdf(renderToHtml({ template: shell, referenceCode: `PMA-${row.id.slice(0, 8).toUpperCase()}-V${row.version}`, issuedDate: new Date(), bodyHtml: merge(row.contentHtml, relation) }));
  const safe = `${relation.property.name} ${relation.landlord.displayName}`.replace(/[^a-z0-9 -]/gi, "").replace(/\s+/g, " ").trim().toUpperCase();
  const fileName = `PROPERTY MANAGEMENT AGREEMENT ${safe}.pdf`; const pdfKey = `property-management-agreements/${session.orgId}/${row.landlordTenancyId}/${row.id}-v${row.version}.pdf`; await putObject(pdfKey, pdf, "application/pdf");
  const generated = await db.$transaction(async (tx) => { await tx.propertyManagementAgreement.updateMany({ where: { organizationId: session.orgId, landlordTenancyId: row.landlordTenancyId, status: "generated" }, data: { status: "superseded" } }); const agreement = await tx.propertyManagementAgreement.update({ where: { id: row.id }, data: { status: "generated", fileName, pdfKey, generatedAt: new Date(), generatedById: session.userId } }); const document = await tx.document.create({ data: { organizationId: session.orgId, fileName, fileType: "application/pdf", fileSize: pdf.length, storageKey: pdfKey, uploadedBy: session.userId } }); await tx.documentLink.create({ data: { organizationId: session.orgId, documentId: document.id, linkedEntityType: "landlord_tenancy", linkedEntityId: row.landlordTenancyId, label: `Property Management Agreement · Version ${row.version}` } }); return agreement; });
  return { ...generated, downloadUrl: await createSignedDownloadUrl(pdfKey) };
}
export async function managementAgreementDownload(session: TenancySession, id: string) { const row = await getDb().propertyManagementAgreement.findFirst({ where: { id, organizationId: session.orgId } }); return row?.pdfKey ? { fileName: row.fileName!, downloadUrl: await createSignedDownloadUrl(row.pdfKey) } : null; }
