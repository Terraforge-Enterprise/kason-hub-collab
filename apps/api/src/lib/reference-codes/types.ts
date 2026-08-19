// apps/api/src/lib/reference-codes/types.ts

import type { DocType } from "../document-templates/types";

export type GenerateInput = {
  orgId: string;
  docType: DocType;
};

export type GeneratedReferenceCode = {
  code: string;
  sequence: number;
  year: number; // 0 if not year-segmented
};
