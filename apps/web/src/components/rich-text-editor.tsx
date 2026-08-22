import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, List, ListOrdered, Underline, Undo2, Redo2 } from "lucide-react";

export type RichTextEditorHandle = { insertHtml: (html: string) => void; focus: () => void };

type FieldMap = Record<string, string>;

function materializeAgreementFields(root: HTMLElement, fieldValues: FieldMap, fieldLabels: FieldMap) {
  const tokenPattern = /{{\s*([a-z0-9_]+)\s*}}/gi;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, [data-agreement-field]")) return NodeFilter.FILTER_REJECT;
      tokenPattern.lastIndex = 0;
      return tokenPattern.test(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  nodes.forEach((textNode) => {
    const text = textNode.textContent ?? "";
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    tokenPattern.lastIndex = 0;
    for (const match of text.matchAll(tokenPattern)) {
      const index = match.index ?? 0;
      if (index > cursor) fragment.append(document.createTextNode(text.slice(cursor, index)));
      const key = match[1].toLowerCase();
      const value = (fieldValues[key] ?? "").trim();
      const label = fieldLabels[key] ?? key.replaceAll("_", " ");
      const display = value || `Missing: ${label}`;
      const span = document.createElement("span");
      span.className = `agreement-auto-field${value ? "" : " agreement-auto-field-missing"}`;
      span.dataset.agreementField = key;
      span.dataset.fieldDisplay = display;
      span.textContent = display;
      fragment.append(span);
      cursor = index + match[0].length;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    textNode.replaceWith(fragment);
  });
}

function buildPagedEditorHtml(value: string, fieldValues: FieldMap, fieldLabels: FieldMap) {
  const staging = document.createElement("div");
  staging.innerHTML = value;
  materializeAgreementFields(staging, fieldValues, fieldLabels);
  const documentRoot = staging.querySelector<HTMLElement>(".word-faithful-template");
  if (!documentRoot || documentRoot.dataset.editorPagination === "true") return staging.innerHTML;

  // Drafts created from the immediately preceding faithful version do not
  // yet carry the editor-only Inventory continuation marker. Detect it from
  // the original Word table text so those drafts still open as 14 pages.
  if (!documentRoot.querySelector(".word-editor-page-break")) {
    const inventoryContinuation = [...documentRoot.querySelectorAll<HTMLTableElement>("table")]
      .find((table) => (table.textContent ?? "").replace(/\s+/g, " ").trim().startsWith("Aircon Servicing"));
    inventoryContinuation?.classList.add("word-editor-page-break");
  }

  const children = [...documentRoot.childNodes];
  const pages: HTMLElement[] = [];
  let page = document.createElement("section");
  const startPage = () => {
    page = document.createElement("section");
    page.className = "word-page-sheet";
    page.dataset.page = String(pages.length + 1);
    pages.push(page);
  };
  startPage();

  for (const child of children) {
    const element = child.nodeType === Node.ELEMENT_NODE ? child as HTMLElement : null;
    const isBoundary = Boolean(
      element?.matches(".word-page-break, .word-editor-page-break")
      || element?.querySelector(".word-page-break"),
    );
    if (isBoundary && page.childNodes.length > 0) startPage();
    page.appendChild(child);
  }

  documentRoot.replaceChildren(...pages);
  documentRoot.dataset.editorPagination = "true";
  return staging.innerHTML;
}

function cleanEditorHtml(editor: HTMLElement) {
  const staging = editor.cloneNode(true) as HTMLElement;
  staging.querySelectorAll<HTMLElement>("[data-agreement-field]").forEach((field) => {
    const key = field.dataset.agreementField;
    if (!key) return;
    const current = (field.textContent ?? "").trim();
    const originalDisplay = (field.dataset.fieldDisplay ?? "").trim();
    field.replaceWith(document.createTextNode(current === originalDisplay ? `{{${key}}}` : current));
  });
  const documentRoot = staging.querySelector<HTMLElement>(".word-faithful-template[data-editor-pagination='true']");
  if (documentRoot) {
    const content = [...documentRoot.querySelectorAll<HTMLElement>(":scope > .word-page-sheet")]
      .flatMap((sheet) => [...sheet.childNodes]);
    documentRoot.replaceChildren(...content);
    delete documentRoot.dataset.editorPagination;
  }
  return staging.innerHTML;
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, { value: string; onChange: (html: string) => void; minHeight?: number; pageMode?: boolean; ariaLabel?: string; fieldValues?: FieldMap; fieldLabels?: FieldMap; readOnly?: boolean }>(function RichTextEditor({ value, onChange, minHeight = 460, pageMode = false, ariaLabel = "Document editor", fieldValues = {}, fieldLabels = {}, readOnly = false }, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef("");
  const lastFieldSignature = useRef("");
  const [pageCount, setPageCount] = useState(1);
  const [activePage, setActivePage] = useState(1);

  const syncPageCount = () => {
    const count = ref.current?.querySelectorAll(":scope .word-page-sheet").length || 1;
    setPageCount(count);
    setActivePage((current) => Math.min(current, count));
  };

  useEffect(() => {
    const fieldSignature = JSON.stringify(fieldValues);
    if (!ref.current || (value === lastEmitted.current && fieldSignature === lastFieldSignature.current)) return;
    if (pageMode) ref.current.innerHTML = buildPagedEditorHtml(value, fieldValues, fieldLabels);
    else {
      const staging = document.createElement("div");
      staging.innerHTML = value;
      materializeAgreementFields(staging, fieldValues, fieldLabels);
      ref.current.innerHTML = staging.innerHTML;
    }
    lastFieldSignature.current = fieldSignature;
    syncPageCount();
  }, [fieldLabels, fieldValues, pageMode, value]);

  const emitChange = () => {
    if (!ref.current) return;
    const html = pageMode ? cleanEditorHtml(ref.current) : ref.current.innerHTML;
    lastEmitted.current = html;
    onChange(html);
  };
  const cmd = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emitChange();
  };
  useImperativeHandle(forwardedRef, () => ({
    focus: () => ref.current?.focus(),
    insertHtml: (html: string) => {
      ref.current?.focus();
      document.execCommand("insertHTML", false, html);
      if (ref.current) materializeAgreementFields(ref.current, fieldValues, fieldLabels);
      emitChange();
    },
  }));

  const updateActivePage = () => {
    const viewport = scrollRef.current;
    const pages = ref.current?.querySelectorAll<HTMLElement>(":scope .word-page-sheet");
    if (!viewport || !pages?.length) return;
    const marker = viewport.scrollTop + 120;
    let current = 1;
    pages.forEach((pageElement, index) => { if (pageElement.offsetTop <= marker) current = index + 1; });
    setActivePage(current);
  };
  const goToPage = (pageNumber: number) => {
    const pageElement = ref.current?.querySelectorAll<HTMLElement>(":scope .word-page-sheet")[pageNumber - 1];
    if (!pageElement || !scrollRef.current) return;
    scrollRef.current.scrollTo({ top: Math.max(0, pageElement.offsetTop - 12), behavior: "smooth" });
    setActivePage(pageNumber);
  };

  const tools = [
    [Bold, "Bold", "bold"], [Italic, "Italic", "italic"], [Underline, "Underline", "underline"],
    [List, "Bullet list", "insertUnorderedList"], [ListOrdered, "Numbered list", "insertOrderedList"],
    [AlignLeft, "Align left", "justifyLeft"], [AlignCenter, "Align centre", "justifyCenter"], [AlignRight, "Align right", "justifyRight"],
    [Undo2, "Undo", "undo"], [Redo2, "Redo", "redo"],
  ] as const;

  return <div className={pageMode ? "overflow-hidden rounded-xl border border-[#9DAFC1] bg-[#DDE3E9]" : "overflow-hidden rounded-xl border border-[#9DAFC1] bg-white"}>
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-[#9DAFC1] bg-[#F3F6F9] p-2 shadow-sm">
      <select aria-label="Text style" className="h-9 rounded-md border border-[#9DAFC1] bg-white px-2 text-sm" onChange={(event) => cmd("formatBlock", event.target.value)} defaultValue="p"><option value="p">Normal</option><option value="h2">Heading</option><option value="h3">Subheading</option></select>
      {tools.map(([Icon, label, command]) => <button type="button" key={command} title={label} aria-label={label} disabled={readOnly} onClick={() => cmd(command)} className="grid h-9 w-9 place-items-center rounded-md text-[#082B4F] hover:bg-[#DFE9F3] disabled:cursor-not-allowed disabled:opacity-35"><Icon className="h-4 w-4" /></button>)}
      {pageMode ? <div className="ml-auto flex items-center gap-2 rounded-lg border border-[#9DAFC1] bg-white px-2 py-1 text-sm font-semibold text-[#082B4F]"><label htmlFor="document-page">Page</label><select id="document-page" aria-label="Jump to page" className="h-7 rounded border border-[#9DAFC1] bg-white px-1" value={activePage} onChange={(event) => goToPage(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select><span className="text-[#657069]">of {pageCount}</span></div> : null}
    </div>
    <div ref={scrollRef} onScroll={updateActivePage} className={pageMode ? "max-h-[72vh] overflow-auto px-5 py-6" : ""}>
      <div ref={ref} role="textbox" aria-label={ariaLabel} aria-multiline="true" aria-readonly={readOnly} contentEditable={!readOnly} suppressContentEditableWarning onInput={emitChange} className={pageMode ? "agreement-word-pages mx-auto outline-none" : "prose max-w-none overflow-auto px-6 py-5 text-[16px] leading-7 text-[#082B4F] outline-none"} style={{ minHeight }} />
    </div>
  </div>;
});
