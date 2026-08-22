import { apiFetch } from "@/lib/api-client";

export type TenancyAgreement = { id: string; tenancyId: string; templateId: string | null; version: number; status: string; contentHtml: string; fileName: string | null; generatedAt: string | null; fields?: Record<string, string> };
export type AgreementTemplate = { id: string; name: string; description: string | null; contentHtml: string; isDefault: boolean };

export async function getTenancyAgreement(tenancyId: string) {
  return (await apiFetch<{ data: { draft: TenancyAgreement; history: TenancyAgreement[] } }>(`/tenancy/tenancies/${tenancyId}/agreement`)).data;
}
export async function saveTenancyAgreement(id: string, contentHtml: string) {
  return (await apiFetch<{ data: TenancyAgreement }>(`/tenancy/agreements/${id}`, { method: "PUT", body: JSON.stringify({ contentHtml }) })).data;
}
export async function transitionTenancyAgreement(id: string, status: string) {
  return (await apiFetch<{ data: TenancyAgreement }>(`/tenancy/agreements/${id}/status`, { method: "POST", body: JSON.stringify({ status }) })).data;
}
export async function generateTenancyAgreement(id: string) {
  return (await apiFetch<{ data: TenancyAgreement & { downloadUrl: string } }>(`/tenancy/agreements/${id}/generate`, { method: "POST" })).data;
}
export async function downloadTenancyAgreement(id: string) {
  return (await apiFetch<{ data: { fileName: string; downloadUrl: string } }>(`/tenancy/agreements/${id}/download`)).data;
}
export async function listAgreementTemplates() { return (await apiFetch<{ data: AgreementTemplate[] }>("/tenancy/agreement-templates")).data; }
export async function saveAgreementTemplate(input: Partial<AgreementTemplate> & { name: string; contentHtml: string }) { return (await apiFetch<{ data: AgreementTemplate }>("/tenancy/agreement-templates", { method: "POST", body: JSON.stringify(input) })).data; }
export async function applyAgreementTemplate(agreementId: string, templateId: string) { return (await apiFetch<{ data: TenancyAgreement }>(`/tenancy/agreements/${agreementId}/apply-template`, { method: "POST", body: JSON.stringify({ templateId }) })).data; }
export async function previewTenancyAgreement(agreementId: string, contentHtml: string) { return (await apiFetch<{ data: { html: string } }>(`/tenancy/agreements/${agreementId}/preview`, { method: "POST", body: JSON.stringify({ contentHtml }) })).data.html; }
export async function previewTenancyAgreementPdf(agreementId: string, contentHtml: string) { return (await apiFetch<{ data: { fileName: string; contentBase64: string } }>(`/tenancy/agreements/${agreementId}/preview-pdf`, { method: "POST", body: JSON.stringify({ contentHtml }) })).data; }
