// apps/api/src/lib/document-templates/types.ts

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

export const DEFAULT_HEADER_FIELDS: HeaderFieldFlags = {
  showLogo: true,
  showRegNo: true,
  showSalesTaxId: false,
  showServiceTaxId: true,
  showAddress: true,
  showEmail: true,
  showContact: true,
};

export type ResolvedTemplate = {
  id: string;
  organizationId: string;
  docType: DocType;
  title: string;
  refPrefix: string;
  refSeparator: string;
  refPadding: number;
  refIncludeYear: boolean;
  headerFields: HeaderFieldFlags;
  orgName: string; // pulled from Organization.name
  orgRegNo: string | null;
  orgSalesTaxId: string | null;
  orgServiceTaxId: string | null;
  orgAddressLines: string[];
  orgEmail: string | null;
  orgContact: string | null;
  logoUrl: string | null; // resolved from logoKey (S3 presigned or data URL)
};

export type RenderPayload = {
  template: ResolvedTemplate;
  referenceCode: string;
  issuedDate: Date;
  dueDate?: Date;
  /**
   * Doc-specific body as an already-rendered HTML string. Callers build their
   * own body (the lib does NOT know about reservation fields, claim splits, etc).
   */
  bodyHtml: string;
  signature?: {
    pngDataUrl: string;
    typedName: string;
    signedAt: Date;
    ip: string;
  };
};
