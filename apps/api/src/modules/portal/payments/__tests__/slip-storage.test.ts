import { describe, it, expect } from "vitest";
import { mintPaymentSlipKey, isOwnedPaymentSlipKey, paymentSlipPrefix } from "../slip-storage";

const ORG = "org-1";
const PARTY = "party-1";
const OTHER_ORG = "org-2";
const OTHER_PARTY = "party-2";

describe("payment slip storage keys", () => {
  it("mints a key under the org+party prefix", () => {
    const key = mintPaymentSlipKey(ORG, PARTY, "receipt.jpg");
    expect(key.startsWith(paymentSlipPrefix(ORG, PARTY))).toBe(true);
    expect(key.endsWith("-receipt.jpg")).toBe(true);
  });

  it("sanitises the filename rather than trusting it", () => {
    // The name arrives from a file picker and lands in a storage path.
    const key = mintPaymentSlipKey(ORG, PARTY, "../../etc/pa ss wd.png");
    expect(key.includes("..")).toBe(false);
    expect(key.startsWith(paymentSlipPrefix(ORG, PARTY))).toBe(true);
  });

  it("survives a filename with no usable characters", () => {
    const key = mintPaymentSlipKey(ORG, PARTY, "///");
    expect(key.startsWith(paymentSlipPrefix(ORG, PARTY))).toBe(true);
    expect(key.endsWith("-slip")).toBe(true);
  });

  it("uniquifies by uuid, so two identically-named slips never collide", () => {
    const a = mintPaymentSlipKey(ORG, PARTY, "IMG_0001.jpg");
    const b = mintPaymentSlipKey(ORG, PARTY, "IMG_0001.jpg");
    expect(a).not.toEqual(b);
  });

  describe("ownership — the authorization boundary for a client-supplied key", () => {
    it("accepts this tenant's own key", () => {
      const key = mintPaymentSlipKey(ORG, PARTY, "slip.pdf");
      expect(isOwnedPaymentSlipKey(key, ORG, PARTY)).toBe(true);
    });

    it("rejects another ORG's key", () => {
      const foreign = mintPaymentSlipKey(OTHER_ORG, PARTY, "slip.pdf");
      expect(isOwnedPaymentSlipKey(foreign, ORG, PARTY)).toBe(false);
    });

    // Org-scoping alone would let one tenant attach a neighbour's slip to their
    // own payment — and GET /payments/:id/proof-urls signs whatever
    // attachmentKeys holds, so that would be a cross-tenant document read.
    it("rejects another PARTY's key inside the same org", () => {
      const neighbour = mintPaymentSlipKey(ORG, OTHER_PARTY, "slip.pdf");
      expect(isOwnedPaymentSlipKey(neighbour, ORG, OTHER_PARTY)).toBe(true);
      expect(isOwnedPaymentSlipKey(neighbour, ORG, PARTY)).toBe(false);
    });

    it("rejects traversal that would escape the prefix", () => {
      const escaped = `${paymentSlipPrefix(ORG, PARTY)}../../${OTHER_ORG}/secret.pdf`;
      // Starts with the right prefix, yet resolves outside it — a plain
      // startsWith check would admit this.
      expect(escaped.startsWith(paymentSlipPrefix(ORG, PARTY))).toBe(true);
      expect(isOwnedPaymentSlipKey(escaped, ORG, PARTY)).toBe(false);
    });

    it("rejects an arbitrary path a client invented", () => {
      expect(isOwnedPaymentSlipKey("orgs/org-1/refund-proofs/x.pdf", ORG, PARTY)).toBe(false);
      expect(isOwnedPaymentSlipKey("", ORG, PARTY)).toBe(false);
      expect(isOwnedPaymentSlipKey("https://evil.example/x.pdf", ORG, PARTY)).toBe(false);
    });

    // A prefix that is a string-prefix of another must not cross-match.
    it("does not confuse a party whose id is a prefix of another", () => {
      const key = mintPaymentSlipKey(ORG, "party-10", "slip.pdf");
      expect(isOwnedPaymentSlipKey(key, ORG, "party-1")).toBe(false);
      expect(isOwnedPaymentSlipKey(key, ORG, "party-10")).toBe(true);
    });
  });
});
