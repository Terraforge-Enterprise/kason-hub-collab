export type PublicReservationDto = {
  referenceCode: string;
  expiresAt: string;
  property: { name: string };
  unit: { unitCode: string };
  carPark: string | null;
  proposedMoveIn: string;
  proposedMoveOut: string | null;
  specialRemarks: string | null;
  charges: {
    reservationDeposit: string;
    documentationFee: string;
    rentalDeposit: string;
    utilityDeposit: string;
    accessCardDeposit: string;
  };
  applicant: {
    fullName: string | null;
    nric: string | null;
    contact: string | null;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postcode: string | null;
    state: string | null;
    country: string | null;
    nationality: string | null;
    occupation: string | null;
    monthlyIncome: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    emergencyContactRelation: string | null;
  };
  documents: { kind: string; filename: string }[];
  customTerms: string[];
  brandLogoUrl: string | null;
};

// Hosted environments serve the web bundle from S3 + CloudFront, which does
// not proxy /public-api/* to the Lightsail API origin. The public API base is
// configured via VITE_PUBLIC_API_BASE (same env knob as public-card/api.ts);
// in dev it defaults to "" so the Vite proxy handles /public-api.
const PUBLIC_API_BASE = import.meta.env.VITE_PUBLIC_API_BASE ?? "";
const PUBLIC_BASE = `${PUBLIC_API_BASE}/public-api/reservations`;

export async function fetchPublicReservation(token: string): Promise<PublicReservationDto> {
  const res = await fetch(`${PUBLIC_BASE}/${token}`);
  if (!res.ok) throw new Error("Not found or link no longer valid");
  const { data } = await res.json();
  return data;
}

export async function fillPublicReservation(
  token: string,
  payload: {
    applicantFullName: string;
    applicantNric: string;
    applicantContact: string;
    applicantEmail: string;
    applicantAddressLine1: string;
    applicantAddressLine2?: string;
    applicantCity: string;
    applicantPostcode: string;
    applicantState: string;
    applicantCountry: string;
    nationality: string;
    emergencyContactName: string;
    emergencyContactPhone: string;
    emergencyContactRelation?: string;
    occupation?: string;
    monthlyIncome?: string;
  },
) {
  const res = await fetch(`${PUBLIC_BASE}/${token}/fill`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Fill failed: ${res.status}`);
  }
  return res.json();
}

export async function signPublicReservation(
  token: string,
  payload: {
    typedName: string;
    agreementTicked: true;
    signaturePngBase64: string;
  },
): Promise<{ id: string; signedPdfDownloadUrl: string }> {
  const res = await fetch(`${PUBLIC_BASE}/${token}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Sign failed: ${res.status}`);
  }
  const { data } = await res.json();
  return data;
}

export type ReservationUploadSigned = {
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
};

export async function requestReservationUploadUrl(
  token: string,
  input: { kind: string; contentType: string; filename: string },
): Promise<ReservationUploadSigned> {
  const res = await fetch(`${PUBLIC_BASE}/${token}/upload-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Upload URL failed: ${res.status}`);
  }
  const { data } = await res.json();
  return data;
}

export async function uploadReservationFile(
  signed: ReservationUploadSigned,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open(signed.method, signed.uploadUrl);
    for (const [k, v] of Object.entries(signed.headers)) xhr.setRequestHeader(k, v);
    xhr.send(file);
  });
}

export async function markReservationDoc(
  token: string,
  body: { kind: string; filename: string },
): Promise<{ id: string; kind: string; filename: string; uploadedAt: string }> {
  const res = await fetch(`${PUBLIC_BASE}/${token}/documents/mark-uploaded`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Mark failed: ${res.status}`);
  }
  const { data } = await res.json();
  return data;
}

export async function deleteReservationDoc(token: string, kind: string): Promise<void> {
  const res = await fetch(`${PUBLIC_BASE}/${token}/documents/${kind}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Delete failed: ${res.status}`);
  }
}
