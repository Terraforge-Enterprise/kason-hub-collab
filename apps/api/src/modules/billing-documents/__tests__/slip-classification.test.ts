// What a transfer slip IS, for the verification panel's inline viewer.
//
// The classification decides two things: which viewer the admin gets, and the
// MIME the client stamps the bytes with before rendering them. It reads the
// storage key's extension and nothing else — see classifySlipKey's own note on
// why the stored content type can't do this job.
import { describe, it, expect } from "vitest";
import { classifySlipKey } from "../pending-payments.service";

const KEY = (name: string) => `orgs/org-1/payment-slips/party-9/aaaa-bbbb-${name}`;

describe("classifySlipKey", () => {
  it("places the photo formats a bank app or a phone produces", () => {
    for (const [name, mime] of [
      ["slip.jpg", "image/jpeg"],
      ["slip.jpeg", "image/jpeg"],
      ["slip.PNG", "image/png"],
      ["slip.webp", "image/webp"],
      ["slip.heic", "image/heic"],
    ] as const) {
      expect(classifySlipKey(KEY(name))).toMatchObject({ kind: "image", mimeType: mime });
    }
  });

  it("places a PDF", () => {
    expect(classifySlipKey(KEY("statement.pdf"))).toMatchObject({
      kind: "pdf",
      mimeType: "application/pdf",
      ext: "pdf",
    });
  });

  it("refuses to guess for anything else — no mimeType means no inline render", () => {
    expect(classifySlipKey(KEY("slip.svg"))).toMatchObject({ kind: "other", mimeType: null });
    expect(classifySlipKey(KEY("slip.html"))).toMatchObject({ kind: "other", mimeType: null });
    expect(classifySlipKey(KEY("slip"))).toMatchObject({ kind: "other", mimeType: null, ext: null });
  });

  it("reads the extension off the FILE, not off the path", () => {
    // The org/party prefix is minted server-side, but the trailing name comes
    // from the tenant's file picker — a dot earlier in the path must not decide
    // how the last segment gets rendered.
    expect(classifySlipKey("orgs/my.org/payment-slips/p1/uuid-slip")).toMatchObject({
      kind: "other",
      ext: null,
    });
  });

  it("treats a dotfile as extension-less rather than as its own extension", () => {
    expect(classifySlipKey(KEY(".jpg"))).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
    expect(classifySlipKey("orgs/o/payment-slips/p/.jpg")).toMatchObject({ kind: "other", ext: null });
  });
});
