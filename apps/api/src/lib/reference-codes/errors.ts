// apps/api/src/lib/reference-codes/errors.ts

import type { DocType } from "../document-templates/types";

export class RefPrefixUnconfiguredError extends Error {
  public readonly code = "REF_PREFIX_UNCONFIGURED";
  constructor(public readonly docType: DocType) {
    super(
      `Reference prefix not configured for docType '${docType}'. Ask an admin to set it in /admin/document-templates.`,
    );
    this.name = "RefPrefixUnconfiguredError";
  }
}
