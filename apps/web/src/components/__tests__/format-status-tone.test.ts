import { describe, it, expect } from "vitest";
import { getStatusTone } from "../format";

describe("getStatusTone (charges v2 additions)", () => {
  it("on_statement → sky", () => expect(getStatusTone("on_statement")).toBe("sky"));
  it("credited stays rose", () => expect(getStatusTone("credited")).toBe("rose"));
  it("unknown still slate", () => expect(getStatusTone("bogus")).toBe("slate"));
});
