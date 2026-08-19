// Tests for the C2 Bills/Proof panel (ProofPackPanel — presentational).
//
// The panel lists each category's bills (filename + thumbnail → BillLightbox), a
// "Download all bills" button (→ the proof-pack endpoint via onDownloadAll), an
// empty-state + DISABLED button when there are zero proofs, and — only in the
// editable (admin) variant — a per-category attach affordance. The portal variant
// is strictly read-only (no attach control).
//
// Presentational: the panel owns NO data fetching — data + the download/attach
// handlers arrive as props, so the admin mount (admin endpoints) and the portal
// mount (owner-scoped, POST-only endpoints) share ONE viewer.
//
// NOTE: native matchers only (toBeTruthy / toBeNull / toHaveBeenCalledWith) — the
// worktree vitest run does NOT register jest-dom, so toBeInTheDocument is absent.
//
// Run with:
//   cd .../phase2-owner-billing/apps/web && \
//     /Users/yonghongtan/github/Kason-Hub/node_modules/.bin/vitest run \
//     src/pages/tenancy/owner-statement/__tests__/proof-pack-panel.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ProofPackPanel } from "../proof-pack-panel";
import type { ExpenseProofGroup } from "@/api/owner-billing";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TNB_URL = "https://signed.example/tnb.png?token=img";
const WATER_URL = "https://signed.example/water.pdf?token=doc";

const GROUPS: ExpenseProofGroup[] = [
  { category: "utilities_tnb", proofs: [{ id: "p1", filename: "tnb.png", url: TNB_URL }] },
  { category: "water", proofs: [{ id: "p2", filename: "water.pdf", url: WATER_URL }] },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProofPackPanel — Bills/Proof panel (C2)", () => {
  it("lists each category's bills (filename + thumbnail) and the thumbnail opens BillLightbox", async () => {
    const { container } = render(<ProofPackPanel groups={GROUPS} onDownloadAll={vi.fn()} />);

    // Image bill → thumbnail <img> with the signed url; both filenames listed.
    expect(container.querySelector(`img[src="${TNB_URL}"]`)).toBeTruthy();
    expect(screen.getByText("tnb.png")).toBeTruthy();
    expect(screen.getByText("water.pdf")).toBeTruthy();

    // No lightbox until a thumbnail is clicked.
    expect(screen.queryByTestId("bill-lightbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview tnb.png" }));

    const lightbox = await screen.findByTestId("bill-lightbox");
    expect(lightbox).toBeTruthy();
    expect(lightbox.getAttribute("role")).toBe("dialog");
    // The big preview <img> carries the signed src (object-contain, not the tile).
    const big = lightbox.querySelector(`img[src="${TNB_URL}"]`);
    expect(big).toBeTruthy();
    expect(big?.className).toContain("object-contain");
  });

  it("'Download all bills' calls onDownloadAll", () => {
    const onDownloadAll = vi.fn();
    render(<ProofPackPanel groups={GROUPS} onDownloadAll={onDownloadAll} />);

    fireEvent.click(screen.getByRole("button", { name: /download all bills/i }));
    expect(onDownloadAll).toHaveBeenCalledTimes(1);
  });

  it("zero proofs → empty state + disabled download button", () => {
    render(<ProofPackPanel groups={[]} onDownloadAll={vi.fn()} />);

    expect(screen.getByText(/no bills/i)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /download all bills/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("editable (admin) variant shows a per-category attach control that posts the RAW category + files", () => {
    const onAttach = vi.fn();
    render(
      <ProofPackPanel
        groups={GROUPS}
        editable
        onAttach={onAttach}
        onDetach={vi.fn()}
        onDownloadAll={vi.fn()}
      />,
    );

    const input = screen.getByTestId("proof-pack-attach-utilities_tnb") as HTMLInputElement;
    const file = new File(["bytes"], "extra-tnb.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onAttach).toHaveBeenCalledWith("utilities_tnb", [file]);
  });

  it("read-only (portal) variant has NO attach control", () => {
    render(<ProofPackPanel groups={GROUPS} onDownloadAll={vi.fn()} />);

    expect(screen.queryByTestId("proof-pack-attach-utilities_tnb")).toBeNull();
    expect(screen.queryByTestId("proof-pack-attach-water")).toBeNull();
    // And the bills are still listed (read-only still SHOWS proof).
    expect(screen.getByText("tnb.png")).toBeTruthy();
  });
});

// ─── Grid-sourced (readOnly) tiles (SDD Task 5) ────────────────────────────
// A grid bill (source:"grid", readOnly:true) is surfaced by resolveStatementBills
// (Task 3/4) but managed exclusively in the Bill Grid — it must NOT be detachable
// from the statement even on the admin (editable) surface. A manual bill
// (source:"manual", readOnly:false — or legacy items with the fields absent)
// keeps its detach affordance unchanged.
const READONLY_GROUPS: ExpenseProofGroup[] = [
  {
    category: "bill_grid",
    proofs: [{ id: "g1", filename: "tnb.pdf", url: "u", source: "grid", readOnly: true }],
  },
  {
    category: "cleaning",
    proofs: [{ id: "m1", filename: "clean.pdf", url: "u", source: "manual", readOnly: false }],
  },
];

describe("ProofPackPanel read-only grid tiles", () => {
  it("grid item hides detach on editable", () => {
    render(<ProofPackPanel groups={READONLY_GROUPS} editable onDownloadAll={vi.fn()} />);
    expect(screen.queryByLabelText("Detach tnb.pdf")).toBeNull();
  });

  it("manual item keeps detach", () => {
    render(<ProofPackPanel groups={READONLY_GROUPS} editable onDownloadAll={vi.fn()} />);
    expect(screen.getByLabelText("Detach clean.pdf")).toBeTruthy();
  });

  it("bill_grid humanises", () => {
    render(<ProofPackPanel groups={READONLY_GROUPS} editable onDownloadAll={vi.fn()} />);
    expect(screen.getByText("Bill Grid")).toBeTruthy();
  });
});
