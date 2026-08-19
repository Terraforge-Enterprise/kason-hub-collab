import { apiFetch, API_BASE, ApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";

export const KNOWN_DOC_TYPES = [
  "reservation_form",
  "rental_commission_claim",
  "invoice",
  "renovation_claim",
  "owner_statement",
  "credit_note",
  "refund_note",
] as const;
export type DocType = (typeof KNOWN_DOC_TYPES)[number];

export type HeaderFieldFlags = {
  showLogo: boolean;
  showRegNo: boolean;
  showSalesTaxId: boolean;
  showServiceTaxId: boolean;
  showAddress: boolean;
  showEmail: boolean;
  showContact: boolean;
};

export type DocumentTemplate = {
  id: string;
  docType: DocType;
  title: string;
  refPrefix: string;
  refSeparator: "-" | " " | "_";
  refPadding: number;
  refIncludeYear: boolean;
  headerFields: HeaderFieldFlags;
  orgName: string;
  orgRegNo: string | null;
  orgSalesTaxId: string | null;
  orgServiceTaxId: string | null;
  orgAddressLines: string[];
  orgEmail: string | null;
  orgContact: string | null;
  logoKey: string | null;
  logoUrl: string | null;
};

export async function listTemplates(): Promise<DocumentTemplate[]> {
  const res = await apiFetch<{ data: DocumentTemplate[] }>(
    "/admin/document-templates",
  );
  return res.data;
}

export async function updateTemplate(
  docType: DocType,
  patch: Omit<DocumentTemplate, "id" | "docType" | "logoUrl" | "orgName">,
): Promise<DocumentTemplate> {
  const res = await apiFetch<{ data: DocumentTemplate }>(
    `/admin/document-templates/${docType}`,
    {
      method: "PUT",
      body: JSON.stringify(patch),
    },
  );
  return res.data;
}

// Proxy upload: POST the raw file as multipart/form-data; the API runs
// stripWhiteBg + persists to Supabase and hands back the storageKey. We
// hit fetch directly (not apiFetch) because apiFetch forces a JSON
// content-type — FormData needs the browser to set its own boundary.
// We still attach the Authorization: Bearer token by hand (like
// bill-attachments.ts) — on the cross-origin UAT deploy the session cookie
// is dropped, so cookie-only auth 401s even for admins.
export async function uploadTemplateLogo(
  docType: DocType,
  file: File,
): Promise<{ storageKey: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/admin/document-templates/${docType}/logo`, {
    method: "POST",
    body: fd,
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error || `Upload failed (${res.status})`, res.status, body?.code);
  }
  const body = (await res.json()) as { data: { storageKey: string } };
  return body.data;
}
