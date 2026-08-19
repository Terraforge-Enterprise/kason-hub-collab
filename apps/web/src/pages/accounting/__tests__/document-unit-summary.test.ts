// The drawer header's Unit field on a MULTI-UNIT document.
//
// A combined owner statement (IVOWN) has apartmentId NULL — it spans every unit
// the owner holds — so `doc.unitCode` is null and the header rendered a bare
// "—". That is technically true and practically useless: the reader is told
// nothing about a document that in fact covers three units. summariseDocumentUnits
// answers from the LINES instead, which each carry their own unit.
import { describe, it, expect } from "vitest";
import { summariseDocumentUnits } from "../document-helpers";

describe("summariseDocumentUnits", () => {
  it("names the single unit when every line shares one", () => {
    expect(summariseDocumentUnits("A-01-01", [{ unitCode: "A-01-01" }, { unitCode: "A-01-01" }])).toBe("A-01-01");
  });

  it("counts the distinct units when the document spans several", () => {
    expect(
      summariseDocumentUnits(null, [
        { unitCode: "A-01-01" },
        { unitCode: "A-01-02" },
        { unitCode: "B-02-07 · Master Room" },
      ]),
    ).toBe("3 units");
  });

  it("does not double-count a unit billed on more than one line", () => {
    expect(
      summariseDocumentUnits(null, [
        { unitCode: "A-01-01" },
        { unitCode: "A-01-01" },
        { unitCode: "A-01-02" },
      ]),
    ).toBe("2 units");
  });

  it("falls back to the document-level unit when no line carries one", () => {
    expect(summariseDocumentUnits("A-19-02", [{ unitCode: null }])).toBe("A-19-02");
  });

  it("returns the em dash when there is no unit anywhere", () => {
    expect(summariseDocumentUnits(null, [{ unitCode: null }])).toBe("—");
    expect(summariseDocumentUnits(null, [])).toBe("—");
  });

  it("names the one line unit even when the document header has none", () => {
    expect(summariseDocumentUnits(null, [{ unitCode: "A-01-03" }])).toBe("A-01-03");
  });
});
