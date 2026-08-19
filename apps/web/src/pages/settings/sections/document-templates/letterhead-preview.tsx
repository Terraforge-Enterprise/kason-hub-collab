/**
 * LetterheadPreview — client-side approximation of the PDF letterhead.
 *
 * Mirrors the 3-zone layout in apps/api/src/lib/document-templates/render.ts
 * so admins see what the rendered PDF will look like as they edit. Uses Arial
 * intentionally (matches the server-side render font) inside an A4-ish paper
 * card so the preview reads as "physical document".
 */
import type { DocumentTemplate } from "@/api/document-templates";
import { LOGO_HEIGHT_PCT } from "@/lib/pdf-layout-constants";

type Props = {
  template: Pick<
    DocumentTemplate,
    | "title"
    | "refPrefix"
    | "refSeparator"
    | "refPadding"
    | "refIncludeYear"
    | "headerFields"
    | "orgRegNo"
    | "orgSalesTaxId"
    | "orgServiceTaxId"
    | "orgAddressLines"
    | "orgEmail"
    | "orgContact"
    | "logoKey"
  >;
  orgName: string;
  logoUrl?: string | null;
};

function fmt(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

export function previewReferenceCode(
  prefix: string,
  separator: string,
  padding: number,
  includeYear: boolean,
): string {
  const seq = String(1).padStart(Math.max(1, padding), "0");
  if (includeYear) {
    return `${prefix}${separator}${new Date().getFullYear()}${separator}${seq}`;
  }
  return `${prefix}${separator}${seq}`;
}

export function LetterheadPreview({ template, orgName, logoUrl }: Props) {
  const h = template.headerFields;
  const today = new Date();
  const due = new Date(today);
  due.setDate(today.getDate() + 30);

  const code = previewReferenceCode(
    template.refPrefix || "PREFIX",
    template.refSeparator,
    template.refPadding,
    template.refIncludeYear,
  );

  const visibleAddress = template.orgAddressLines.filter((l) => l.trim().length > 0);

  return (
    <div
      className="@container aspect-[210/297] w-full overflow-hidden rounded-md bg-white text-zinc-900 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.35)] ring-1 ring-black/5"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      aria-label="Letterhead preview"
    >
      <div className="grid h-full grid-rows-[auto_1fr] gap-3 p-5">
        {/* Header — mirrors render.ts grid-template-columns: 1fr 2fr 1fr */}
        <header className="grid grid-cols-[1fr_2fr_1fr] items-start gap-3 border-b border-zinc-200 pb-3">
          {/* zone-left: logo */}
          <div className="flex items-center justify-center">
            {h.showLogo && logoUrl ? (
              <img
                src={logoUrl}
                alt="logo"
                className="max-w-full object-contain"
                style={{ maxHeight: `${LOGO_HEIGHT_PCT}cqh` }}
              />
            ) : h.showLogo ? (
              <div
                className="flex aspect-square items-center justify-center rounded-sm border border-dashed border-zinc-300 text-[7px] uppercase tracking-wider text-zinc-400"
                style={{ height: `${LOGO_HEIGHT_PCT}cqh` }}
              >
                Logo
              </div>
            ) : null}
          </div>

          {/* zone-center: org info */}
          <div className="text-center text-[8.5px] leading-snug text-zinc-600">
            <h1 className="mb-1 text-[11px] font-bold uppercase tracking-wide text-zinc-900">
              {orgName}
            </h1>
            {h.showRegNo && template.orgRegNo && <p>Reg No: {template.orgRegNo}</p>}
            {h.showSalesTaxId && template.orgSalesTaxId && (
              <p>Sales Tax ID: {template.orgSalesTaxId}</p>
            )}
            {h.showServiceTaxId && template.orgServiceTaxId && (
              <p>Service Tax ID: {template.orgServiceTaxId}</p>
            )}
            {h.showAddress &&
              visibleAddress.map((line, i) => <p key={`addr-${i}`}>{line}</p>)}
            {h.showEmail && template.orgEmail && <p>Email: {template.orgEmail}</p>}
            {h.showContact && template.orgContact && <p>Contact: {template.orgContact}</p>}
          </div>

          {/* zone-right: document info */}
          <div className="text-right text-[8.5px] leading-relaxed">
            <h2 className="mb-2 text-[10px] font-bold uppercase leading-tight text-zinc-900">
              {/* Match render.ts: split on "\n" so per-docType overrides
                  ("Rental Commission\nClaim Form") wrap at the intended point. */}
              {(template.title || "Document Title").split("\n").map((line, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </h2>
            <p>
              Reference Number: <br />
              <span className="font-semibold">{code}</span>
            </p>
            <p className="mt-1">Date: {fmt(today)}</p>
            <p>Due Date: {fmt(due)}</p>
          </div>
        </header>

        {/* Body placeholder — gives sense of document continuation */}
        <main className="space-y-2 text-[8px] leading-relaxed text-zinc-400">
          <p className="italic">Sample body content…</p>
          <div className="space-y-1">
            <div className="h-1.5 w-3/4 rounded bg-zinc-100" />
            <div className="h-1.5 w-2/3 rounded bg-zinc-100" />
            <div className="h-1.5 w-4/5 rounded bg-zinc-100" />
            <div className="h-1.5 w-1/2 rounded bg-zinc-100" />
          </div>
          <div className="space-y-1 pt-2">
            <div className="h-1.5 w-2/3 rounded bg-zinc-100" />
            <div className="h-1.5 w-3/4 rounded bg-zinc-100" />
            <div className="h-1.5 w-1/2 rounded bg-zinc-100" />
          </div>
        </main>
      </div>
    </div>
  );
}
