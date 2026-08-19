// apps/api/src/modules/document-templates/__tests__/service.test.ts

import { describe, it, expect, beforeEach, vi } from "vitest";
import { listTemplatesService, updateTemplateService } from "../service";
import * as repo from "../../../lib/document-templates/repository";
import * as storage from "../../../lib/storage";
import { DEFAULT_HEADER_FIELDS, KNOWN_DOC_TYPES } from "../../../lib/document-templates/types";

vi.mock("../../../lib/document-templates/repository");
vi.mock("../../../lib/storage");

/** A persisted row as the repository hands it back. */
function row(over: Partial<repo.DocumentTemplateRow> = {}): repo.DocumentTemplateRow {
  return {
    id: "tpl-1",
    organizationId: "org-1",
    docType: "reservation_form",
    title: "Unit Reservation Form",
    refPrefix: "",
    refSeparator: "-",
    refPadding: 5,
    refIncludeYear: false,
    headerFields: { ...DEFAULT_HEADER_FIELDS },
    orgRegNo: null,
    orgSalesTaxId: null,
    orgServiceTaxId: null,
    orgAddressLines: [],
    orgEmail: null,
    orgContact: null,
    logoKey: null,
    ...over,
  };
}

function seedUpsert() {
  vi.mocked(repo.upsertTemplate).mockImplementation(async (orgId, docType, data) => ({
    id: `tpl-${docType}`,
    organizationId: orgId,
    docType,
    ...data,
  }));
}

describe("listTemplatesService", () => {
  beforeEach(() => vi.clearAllMocks());

  // Regression: a logoKey pointing at a storage object that no longer exists
  // (bucket wiped, object moved, row carried over from another org) used to
  // reject out of attachLogoUrl and 500 the whole GET, leaving the Settings →
  // Document Templates page with a header and nothing else. reservation_form is
  // FIRST in KNOWN_DOC_TYPES, so the very first iteration took out all 7 cards.
  it("returns every doc type even when a logoKey cannot be signed", async () => {
    vi.mocked(repo.listTemplates).mockResolvedValue([
      row({ docType: "reservation_form", logoKey: "org-templates/other-org/logo.png" }),
    ]);
    seedUpsert();
    vi.mocked(storage.createSignedDownloadUrl).mockRejectedValue(
      new Error("Failed to create signed download URL: Object not found"),
    );

    const result = await listTemplatesService("org-1");

    expect(result).toHaveLength(KNOWN_DOC_TYPES.length);
    expect(result.find((r) => r.docType === "reservation_form")?.logoUrl).toBeNull();
  });

  // Guard for the other half of the fix: the tolerate-failure path must not
  // swallow logos that DO resolve, or every letterhead preview silently loses
  // its logo and the regression above would look "fixed" while being broken.
  it("attaches the signed URL when the logoKey resolves", async () => {
    vi.mocked(repo.listTemplates).mockResolvedValue([
      row({ docType: "reservation_form", logoKey: "org-templates/org-1/logo.png" }),
    ]);
    seedUpsert();
    vi.mocked(storage.createSignedDownloadUrl).mockResolvedValue("https://signed.example/logo.png");

    const result = await listTemplatesService("org-1");

    expect(result.find((r) => r.docType === "reservation_form")?.logoUrl).toBe(
      "https://signed.example/logo.png",
    );
  });

  it("returns all known doc types, auto-seeding any missing", async () => {
    vi.mocked(repo.listTemplates).mockResolvedValue([]);
    vi.mocked(repo.upsertTemplate).mockImplementation(async (orgId, docType, data) => ({
      id: `tpl-${docType}`,
      organizationId: orgId,
      docType,
      ...data,
    }));

    const result = await listTemplatesService("org-1");

    expect(result).toHaveLength(KNOWN_DOC_TYPES.length);
    expect(repo.upsertTemplate).toHaveBeenCalledTimes(KNOWN_DOC_TYPES.length);
  });
});

const basePatch = {
  title: "Custom Title",
  refPrefix: "KAEN RES",
  refSeparator: "-" as const,
  refPadding: 5,
  refIncludeYear: false,
  headerFields: { ...DEFAULT_HEADER_FIELDS },
  orgRegNo: "1610050-V",
  orgSalesTaxId: null,
  orgServiceTaxId: "W10",
  orgAddressLines: ["L1", "L2"],
  orgEmail: "a@b.com",
  orgContact: "+60",
  logoKey: null,
};

describe("updateTemplateService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the patch verbatim", async () => {
    vi.mocked(repo.upsertTemplate).mockImplementation(async (orgId, docType, data) => ({
      id: "tpl-1",
      organizationId: orgId,
      docType,
      ...data,
    }));

    const patch = { ...basePatch };

    const result = await updateTemplateService("org-1", "reservation_form", patch);
    expect(result.title).toBe("Custom Title");
    expect(repo.upsertTemplate).toHaveBeenCalledWith("org-1", "reservation_form", patch);
  });

  // Same attachLogoUrl path as the list: a broken stored logoKey must not make
  // the Save fail, otherwise the admin can't edit their way out of it.
  it("saves the patch even when the stored logoKey cannot be signed", async () => {
    vi.mocked(repo.upsertTemplate).mockResolvedValue(
      row({ title: "Custom Title", logoKey: "org-templates/other-org/logo.png" }),
    );
    vi.mocked(storage.createSignedDownloadUrl).mockRejectedValue(
      new Error("Failed to create signed download URL: Object not found"),
    );

    const result = await updateTemplateService("org-1", "reservation_form", {
      ...basePatch,
      logoKey: "org-templates/other-org/logo.png",
    });

    expect(result.title).toBe("Custom Title");
    expect(result.logoUrl).toBeNull();
  });
});
