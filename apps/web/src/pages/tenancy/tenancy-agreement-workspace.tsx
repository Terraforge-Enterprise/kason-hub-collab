import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Download, FilePlus2, FileSignature, FileText, Loader2, Plus, Save, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/rich-text-editor";
import { applyAgreementTemplate, downloadTenancyAgreement, generateTenancyAgreement, getTenancyAgreement, listAgreementTemplates, previewTenancyAgreementPdf, saveAgreementTemplate, saveTenancyAgreement, transitionTenancyAgreement } from "@/api/tenancy-agreements";
import type { TenancyListItem } from "./tenancies-table";

type Step = "choose" | "new-template" | "edit";
const BLANK_TEMPLATE = `<h1 style="text-align:center">TENANCY AGREEMENT</h1><p>This Tenancy Agreement is made between <strong>{{owner_name}}</strong> (the Landlord) and <strong>{{tenant_name}}</strong> (the Tenant).</p><h2>1. Premises</h2><p>{{property_name}} {{unit_number}}<br>{{property_address}}</p><h2>2. Tenancy Period</h2><p>From {{start_date}} to {{end_date}}.</p><h2>3. Monthly Rent</h2><p>RM {{monthly_rent}}</p><h2>4. Deposit</h2><p>RM {{rental_deposit}}</p><h2>5. Terms and Conditions</h2><p>Type the standard terms and conditions here.</p><h2>6. Special Conditions</h2><p>Type any special arrangements here.</p><h2>Signatures</h2><p>Landlord: ____________________ &nbsp;&nbsp; Tenant: ____________________</p>`;
const FIELD_LABELS: Record<string, string> = {
  agreement_date: "Agreement date", agreement_day: "Agreement day", agreement_month_year: "Agreement month and year",
  owner_name: "Owner name", owner_id: "Owner NRIC / ID", owner_phone: "Owner phone", owner_email: "Owner email",
  tenant_name: "Tenant name", tenant_id: "Tenant NRIC / ID", tenant_phone: "Tenant phone", tenant_email: "Tenant email",
  property_name: "Property / Condo", unit_number: "Unit number", property_address: "Full premises address",
  tenancy_duration: "Tenancy duration", start_date: "Tenancy start", end_date: "Tenancy end",
  monthly_rent: "Monthly rent", rental_deposit: "Security deposit", utilities_deposit: "Utilities deposit", access_card_deposit: "Access card deposit",
  rent_due_day: "Rent due day", payment_bank_name: "Payment bank", payment_account_name: "Beneficiary name",
  payment_account_number: "Payment account number", payment_email: "Payment email", permitted_use: "Permitted use", tenancy_code: "Tenancy code",
};
const REQUIRED_AGREEMENT_FIELDS = ["owner_name", "owner_id", "tenant_name", "tenant_id", "property_address", "start_date", "end_date", "monthly_rent", "rental_deposit", "payment_bank_name", "payment_account_number"];
const STATUS_LABELS: Record<string, string> = { draft: "Draft", ready_review: "Ready for Review", approved: "Approved", generated: "Generated", sent_for_signature: "Sent for Signature", signed: "Signed", superseded: "Superseded" };
const SPECIAL_CLAUSES = [
  ["Parking", "Parking allocation: ____________________. The parking bay may only be used by the approved occupant and vehicle."],
  ["No pets", "Pets are not permitted at the premises without the Landlord's prior written consent."],
  ["Utilities", "The Tenant shall bear and settle the utilities allocated to the Tenant during the tenancy period."],
  ["Early termination", "Any early termination is subject to the notice, compensation and written agreement stated in this Agreement."],
] as const;

export function TenancyAgreementButton({ tenancy }: { tenancy: TenancyListItem }) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" variant="outline" size="sm" className="gap-1.5 whitespace-nowrap" onClick={() => setOpen(true)}><FileSignature className="h-4 w-4" />Create / Open Agreement</Button>{open ? <TenancyAgreementWorkspace tenancy={tenancy} onClose={() => setOpen(false)} /> : null}</>;
}

function TenancyAgreementWorkspace({ tenancy, onClose }: { tenancy: TenancyListItem; onClose: () => void }) {
  const qc = useQueryClient(); const editorRef = useRef<RichTextEditorHandle>(null);
  const [step, setStep] = useState<Step>("choose"); const [selectedTemplate, setSelectedTemplate] = useState(""); const [content, setContent] = useState<string | null>(null); const [templateName, setTemplateName] = useState(""); const [editingTemplateId, setEditingTemplateId] = useState<string | undefined>();
  const [fieldToInsert, setFieldToInsert] = useState("");
  const [previewError, setPreviewError] = useState("");
  const query = useQuery({ queryKey: ["tenancy-agreement", tenancy.id], queryFn: () => getTenancyAgreement(tenancy.id) });
  const templates = useQuery({ queryKey: ["tenancy-agreement-templates"], queryFn: listAgreementTemplates });
  const draft = query.data?.draft; const value = content ?? draft?.contentHtml ?? ""; const fields = draft?.fields ?? {};
  const missingRequiredFields = REQUIRED_AGREEMENT_FIELDS.filter((key) => !fields[key] || fields[key].trim() === "—");
  const apply = useMutation({ mutationFn: (templateId: string) => applyAgreementTemplate(draft!.id, templateId), onSuccess: (row) => { setContent(row.contentHtml); setStep("edit"); } });
  const createTemplate = useMutation({ mutationFn: () => saveAgreementTemplate({ id: editingTemplateId, name: templateName.trim(), contentHtml: content ?? BLANK_TEMPLATE }), onSuccess: async (template) => { await apply.mutateAsync(template.id); setSelectedTemplate(template.id); setEditingTemplateId(undefined); void qc.invalidateQueries({ queryKey: ["tenancy-agreement-templates"] }); } });
  const save = useMutation({ mutationFn: () => saveTenancyAgreement(draft!.id, value), onSuccess: () => { setContent(null); void qc.invalidateQueries({ queryKey: ["tenancy-agreement", tenancy.id] }); } });
  const previewPdf = useMutation({ mutationFn: async () => { if (draft!.status === "draft") await saveTenancyAgreement(draft!.id, value); return previewTenancyAgreementPdf(draft!.id, value); } });
  const generate = useMutation({ mutationFn: () => generateTenancyAgreement(draft!.id), onSuccess: (row) => { window.open(row.downloadUrl, "_blank", "noopener,noreferrer"); setContent(null); void qc.invalidateQueries({ queryKey: ["tenancy-agreement", tenancy.id] }); } });
  const transition = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => transitionTenancyAgreement(id, status), onSuccess: () => { setContent(null); void qc.invalidateQueries({ queryKey: ["tenancy-agreement", tenancy.id] }); } });
  const saveAndSubmitReview = async () => { if (!draft) return; await saveTenancyAgreement(draft.id, value); transition.mutate({ id: draft.id, status: "ready_review" }); };
  const hasGenerated = (query.data?.history.some((x) => Boolean(x.fileName)) ?? false);
  const daysToTenancyEnd = tenancy.endDate ? Math.ceil((new Date(tenancy.endDate).getTime() - Date.now()) / 86_400_000) : null;
  const close = () => { if (content != null && content !== draft?.contentHtml && !window.confirm("Close without saving your latest edits?")) return; onClose(); };
  const openPdfPreview = () => {
    setPreviewError("");
    const previewWindow = window.open("", "_blank");
    if (previewWindow) {
      previewWindow.document.title = "Preparing tenancy agreement preview";
      previewWindow.document.body.innerHTML = '<p style="font:16px Arial;padding:24px;color:#082B4F">Preparing PDF preview...</p>';
    }
    previewPdf.mutate(undefined, {
      onSuccess: (result) => {
        const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0));
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        if (previewWindow) previewWindow.location.replace(objectUrl);
        else window.location.assign(objectUrl);
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);
      },
      onError: (error) => {
        previewWindow?.close();
        setPreviewError(error instanceof Error ? error.message : "PDF preview could not be created.");
      },
    });
  };

  return <div className="fixed inset-y-3 left-3 right-3 z-[120] flex overflow-hidden rounded-2xl border border-[#9DAFC1] bg-[#DDE3E9] shadow-2xl lg:left-[16rem]" role="dialog" aria-modal="true">
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#9DAFC1] bg-white px-5 py-3 shadow-sm"><div className="flex min-w-0 items-center gap-3"><FileSignature className="h-7 w-7 shrink-0 text-[#C9A35C]" /><div className="min-w-0"><h1 className="truncate text-xl font-bold text-[#082B4F]">Tenancy Agreement · {tenancy.tenancyCode}</h1><p className="truncate text-sm text-[#657069]">{tenancy.propertyName} {tenancy.unitCode} · {tenancy.tenantName}</p></div></div><Button variant="outline" onClick={close}>Close</Button></header>
      {query.isLoading || templates.isLoading ? <div className="grid flex-1 place-items-center"><Loader2 className="h-8 w-8 animate-spin text-[#082F55]" /></div> : <main className="min-h-0 flex-1 overflow-auto p-5">
        {step === "choose" ? <div className="mx-auto max-w-5xl space-y-5"><div><h2 className="text-2xl font-bold text-[#082B4F]">{hasGenerated ? "Edit or create another agreement version" : "Create Tenancy Agreement"}</h2><p className="mt-1 text-[#657069]">Choose a saved template, or create a new reusable Word-style template.</p></div>
          {daysToTenancyEnd != null && daysToTenancyEnd <= 60 ? <section className={`rounded-2xl border p-4 ${tenancy.renewalDecision === "renew" ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}><h3 className="font-bold text-[#082B4F]">Renewal / move-out attention</h3><p className="mt-1 text-sm text-[#657069]">This tenancy {daysToTenancyEnd < 0 ? `ended ${Math.abs(daysToTenancyEnd)} day(s) ago` : `ends in ${daysToTenancyEnd} day(s)`}. Renewal decision: <strong>{tenancy.renewalDecision?.replaceAll("_", " ") ?? "Pending"}</strong>. Create a renewed agreement only after the dates, rent and renewal fee are confirmed; otherwise continue the move-out workflow.</p></section> : null}
          {draft?.contentHtml ? <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5 md:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold text-emerald-950">Editable draft available</h3><p className="text-sm text-emerald-800">Continue without replacing your current wording with another template.</p></div><Button onClick={() => setStep("edit")}>Continue Editing Draft</Button></div></section> : null}
          <div className="grid gap-5 md:grid-cols-2"><section className="rounded-2xl border border-[#9DAFC1] bg-white p-6 shadow-sm"><FileText className="mb-3 h-8 w-8 text-[#C9A35C]" /><h3 className="text-lg font-bold text-[#082B4F]">Use existing template</h3><p className="mb-4 text-sm text-[#657069]">Standard clauses stay consistent; tenant, owner, unit and tenancy details fill automatically.</p><select className="h-12 w-full rounded-lg border border-[#9DAFC1] bg-white px-3" value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}><option value="">Select a template</option>{templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (Default)" : ""}</option>)}</select><div className="mt-4 grid grid-cols-2 gap-2"><Button disabled={!selectedTemplate || !draft || apply.isPending} onClick={() => apply.mutate(selectedTemplate)}>Use Template</Button><Button variant="outline" disabled={!selectedTemplate} onClick={() => { const template = templates.data?.find((x) => x.id === selectedTemplate); if (!template) return; setEditingTemplateId(template.id); setTemplateName(template.name); setContent(template.contentHtml); setStep("new-template"); }}>Edit Template</Button></div></section>
          <section className="rounded-2xl border border-[#C9A35C] bg-[#FFFDF7] p-6 shadow-sm"><FilePlus2 className="mb-3 h-8 w-8 text-[#C9A35C]" /><h3 className="text-lg font-bold text-[#082B4F]">Create new template</h3><p className="mb-4 text-sm text-[#657069]">Open a blank Word-style document, insert automatic fields deliberately, then save it for future agreements.</p><Button variant="outline" className="w-full" onClick={() => { setEditingTemplateId(undefined); setTemplateName(""); setContent(BLANK_TEMPLATE); setStep("new-template"); }}>Create New Template</Button></section></div>
          {hasGenerated ? <section className="rounded-2xl border border-[#9DAFC1] bg-white p-5"><h3 className="font-bold text-[#082B4F]">Agreement versions & signing</h3><div className="mt-3 space-y-2">{query.data!.history.filter((x) => x.fileName).map((x) => <div key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#DFE9F3] bg-[#F8FAFC] p-3"><div><div className="font-semibold text-[#082B4F]">Version {x.version} · {STATUS_LABELS[x.status] ?? x.status}</div><div className="text-xs text-[#657069]">{x.fileName}{x.generatedAt ? ` · ${new Date(x.generatedAt).toLocaleString("en-MY")}` : ""}</div></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={async () => { const d = await downloadTenancyAgreement(x.id); window.open(d.downloadUrl, "_blank", "noopener,noreferrer"); }}><Download className="mr-2 h-4 w-4" />Download</Button>{x.status === "generated" ? <Button variant="outline" onClick={() => transition.mutate({ id: x.id, status: "sent_for_signature" })}>Mark Sent</Button> : null}{["generated", "sent_for_signature"].includes(x.status) ? <Button onClick={() => transition.mutate({ id: x.id, status: "signed" })}>Mark Signed</Button> : null}</div></div>)}</div></section> : null}
        </div> : <div className="mx-auto max-w-[1320px] space-y-4">
          <div className="rounded-xl border border-[#9DAFC1] bg-white p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold text-[#082B4F]">{step === "new-template" ? (editingTemplateId ? "Edit Template" : "Create New Template") : "Edit Tenancy Agreement"}</h2>{step === "edit" && draft ? <span className="rounded-full border border-[#C9A35C] bg-[#FFF8E8] px-2 py-0.5 text-xs font-bold text-[#082B4F]">{STATUS_LABELS[draft.status] ?? draft.status}</span> : null}</div><p className="text-sm text-[#657069]">Scroll through separate Letter pages below, just like a Word document.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setStep("choose")}>Back</Button>{step === "new-template" ? <><input className="h-10 min-w-[260px] rounded-lg border border-[#9DAFC1] px-3" placeholder="Template name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} /><Button disabled={!templateName.trim() || createTemplate.isPending} onClick={() => createTemplate.mutate()}><Save className="mr-2 h-4 w-4" />{editingTemplateId ? "Update Template" : "Save Template"}</Button></> : <><Button variant="outline" disabled={save.isPending || draft?.status !== "draft"} onClick={() => save.mutate()}><Save className="mr-2 h-4 w-4" />Save Draft</Button><Button variant="outline" disabled={previewPdf.isPending} onClick={openPdfPreview}>{previewPdf.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}Preview PDF</Button>{draft?.status === "draft" ? <Button disabled={missingRequiredFields.length > 0 || transition.isPending} onClick={saveAndSubmitReview}>Ready for Review</Button> : null}{draft?.status === "ready_review" ? <><Button variant="outline" onClick={() => transition.mutate({ id: draft.id, status: "draft" })}>Return to Draft</Button><Button onClick={() => transition.mutate({ id: draft.id, status: "approved" })}>Approve</Button></> : null}{draft?.status === "approved" ? <><Button variant="outline" onClick={() => transition.mutate({ id: draft.id, status: "draft" })}>Return to Draft</Button><Button disabled={generate.isPending || missingRequiredFields.length > 0} onClick={() => generate.mutate()}><Download className="mr-2 h-4 w-4" />Generate Final PDF</Button></> : null}</>}</div></div>{previewError ? <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700"><AlertCircle className="h-4 w-4" />{previewError}</div> : null}</div>
          <div className="grid min-h-0 gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-4 xl:sticky xl:top-0 xl:max-h-[72vh] xl:overflow-auto">
              <section className="rounded-xl border border-[#9DAFC1] bg-white p-4">
                <h3 className="flex items-center gap-2 font-bold text-[#082B4F]"><Sparkles className="h-4 w-4 text-[#C9A35C]" />Automatic details</h3>
                <p className="mt-1 text-xs leading-5 text-[#657069]">These details are linked to the tenancy record. The information cards are read-only and will not change the document when clicked.</p>
                <div className="mt-3 rounded-lg border border-[#C9A35C] bg-[#FFFDF7] p-3">
                  <label htmlFor="agreement-field" className="text-xs font-bold text-[#082B4F]">Insert an automatic field</label>
                  <select id="agreement-field" className="mt-1 h-10 w-full rounded-md border border-[#9DAFC1] bg-white px-2 text-sm" value={fieldToInsert} onChange={(event) => setFieldToInsert(event.target.value)}>
                    <option value="">Choose a field</option>
                    {Object.keys(FIELD_LABELS).map((key) => <option key={key} value={key}>{FIELD_LABELS[key]}</option>)}
                  </select>
                  <Button type="button" variant="outline" className="mt-2 w-full" disabled={!fieldToInsert} onClick={() => editorRef.current?.insertHtml(`<span data-field="${fieldToInsert}">{{${fieldToInsert}}}</span>&nbsp;`)}><Plus className="mr-2 h-4 w-4" />Insert at cursor</Button>
                </div>
                <div className="mt-3 space-y-2">
                  {Object.keys(FIELD_LABELS).map((key) => <div key={key} className="rounded-lg border border-[#DFE9F3] bg-[#F8FAFC] p-2 text-left"><span className="block text-xs font-bold text-[#082B4F]">{FIELD_LABELS[key]}</span>{step === "edit" ? <span className="block truncate text-xs text-[#657069]">{fields[key] || "Missing in system"}</span> : <span className="block text-xs text-[#657069]">Automatic field</span>}</div>)}
                </div>
              </section>
              {step === "edit" ? <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900"><div className="flex items-center gap-2 font-bold"><Check className="h-4 w-4" />Details linked</div><p className="mt-1 text-xs">Changing the Owner, Tenant or Tenancy record updates the next preview automatically.</p></section> : null}
              {step === "edit" ? <section className={`rounded-xl border p-4 ${missingRequiredFields.length ? "border-red-300 bg-red-50" : "border-emerald-300 bg-emerald-50"}`}><h3 className="font-bold text-[#082B4F]">Agreement checklist</h3><p className="mt-1 text-xs text-[#657069]">Final generation is unlocked only after all critical information is available.</p><div className="mt-3 space-y-1.5">{REQUIRED_AGREEMENT_FIELDS.map((key) => { const complete = !missingRequiredFields.includes(key); return <div key={key} className="flex items-center gap-2 text-xs"><span className={`grid h-4 w-4 place-items-center rounded-full ${complete ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}`}>{complete ? "✓" : "!"}</span><span className={complete ? "text-emerald-900" : "font-semibold text-red-800"}>{FIELD_LABELS[key]}</span></div>; })}</div></section> : null}
              {step === "edit" && draft?.status === "draft" ? <section className="rounded-xl border border-[#C9A35C] bg-[#FFFDF7] p-4"><h3 className="font-bold text-[#082B4F]">Special conditions</h3><p className="mt-1 text-xs text-[#657069]">Place your cursor under the Special Conditions section, then insert a starting clause and edit it freely.</p><div className="mt-3 grid grid-cols-2 gap-2">{SPECIAL_CLAUSES.map(([label, clause]) => <Button key={label} type="button" variant="outline" size="sm" onClick={() => editorRef.current?.insertHtml(`<p>${clause}</p>`)}>{label}</Button>)}</div></section> : null}
            </aside>
            <RichTextEditor
              ref={editorRef}
              value={value}
              onChange={setContent}
              minHeight={1056}
              pageMode
              fieldValues={step === "edit" ? fields : Object.fromEntries(Object.entries(FIELD_LABELS).map(([key, label]) => [key, `[${label}]`]))}
              fieldLabels={FIELD_LABELS}
              readOnly={step === "edit" && draft?.status !== "draft"}
              ariaLabel={step === "new-template" ? "New tenancy agreement template editor" : "Tenancy agreement editor"}
            />
          </div>
        </div>}
      </main>}
    </div>
  </div>;
}
