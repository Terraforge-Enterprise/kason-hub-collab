// Dev-only design preview for invoice-adjustments (first-class credit/debit
// notes) — plan "PHASE PREVIEW", spec D6. Renders the REAL production
// components (DocumentsTable, DocumentDetailDrawer and its Payments/
// Adjustments tabs) against a static mock fixture (see ./fixtures.ts), never
// the network, so what you see here is exactly what ships once the components
// are wired into the real /accounting pages. Record payment and Add adjustment
// are inline inside the drawer's tabs — there is no separate create-note popup.
//
// Registered ONLY under import.meta.env.DEV || VITE_DESIGN_PREVIEW
// (apps/web/src/router.tsx) — never present in a production build.
//
// Navigation: `?state=<id>` selects ONE of 9 named states (some states cover
// more than one of the plan's "12 states" via in-page tab switching — see the
// STATES list below). No `state` param renders a human-browsable index.
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Surface, TableWrap, DataTable, TableHead, HeadCell, BodyCell, Row } from "@/components/ui";
import { DocumentsTable } from "@/pages/accounting/document-shared";
import { DocumentDetailDrawer } from "@/pages/accounting/document-detail-drawer";
import {
  REGISTER_ITEMS,
  INVOICE_FINAL,
  INVOICE_DN_ONLY,
  INVOICE_CN_ONLY,
  CN_NOTE,
  DN_NOTE,
  seedPreviewQueryClient,
} from "./fixtures";

const STATES = [
  { id: "register", label: "1. Mixed register", note: "Non-additive face amounts (D3)." },
  {
    id: "invoiceDetail",
    label: "2-5. Line items / Payments / Adjustments / Activity",
    note: "One drawer — switch tabs. Record payment + Add adjustment are now INLINE inside the Payments/Adjustments tabs — no popup drawer.",
  },
  { id: "cnDetail", label: "6. CN detail", note: "" },
  { id: "dnDetail", label: "7. DN detail", note: "" },
  { id: "paidToOutstanding", label: "8. Paid → outstanding after a DN", note: "" },
  { id: "paidToCredit", label: "9. Paid → credit balance after a CN", note: "" },
  { id: "invoiceLevel", label: "10. Invoice-level adjustment (design-only, deferred §7-A1)", note: "" },
] as const;
type StateId = (typeof STATES)[number]["id"];

/** Small top-left orientation label shown on overlay (Sheet) states, which
 * cover most of the viewport — a full nav bar there would collide with the
 * drawer. */
function StateLabel({ id }: { id: StateId }) {
  const meta = STATES.find((s) => s.id === id);
  return (
    <div className="fixed left-4 top-4 z-[60] rounded-md border border-border/50 bg-background/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
      Design preview — {meta?.label ?? id}
    </div>
  );
}

function IndexNav() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-3xl p-8">
      <PageHeader
        title="Invoice adjustments — design preview"
        description="Dev-only. Static mock fixture (IVTEN-0002 canonical scenario). Pick a state or drive this page with ?state=<id> from Puppeteer."
      />
      <Surface title="States">
        <ul className="divide-y divide-border/50">
          {STATES.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium text-foreground">{s.label}</p>
                {s.note ? <p className="text-xs text-muted-foreground">{s.note}</p> : null}
              </div>
              <Button variant="outline" size="sm" onClick={() => navigate(`?state=${s.id}`)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      </Surface>
    </div>
  );
}

function RegisterState() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-8">
      <PageHeader
        title="All documents (mixed register)"
        description="Spec D3: each row shows its OWN face amount — invoice neutral, credit note −, debit note +. No summed footer; rows are non-additive."
      />
      <Surface title="Register">
        <DocumentsTable
          items={REGISTER_ITEMS}
          onRowClick={() => {}}
          emptyLabel="No documents."
          showAdjustmentFace
        />
      </Surface>
    </div>
  );
}

/** State 10 — design-only mock. NOT wired to the Adjustments tab's inline
 * add-row or any write path (spec §7-A1: chargeId=null correction notes are a
 * STOP condition, deferred pending a user decision). Assembled from existing
 * atoms only. */
function InvoiceLevelDesignOnlyState() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-8">
      <PageHeader
        title="Invoice-level adjustment"
        description="A correction that changes the invoice total WITHOUT targeting a specific charge/line."
      />
      <Callout variant="warning" title="Design-only — deferred (spec §7-A1)">
        This first cut ships CHARGE-SCOPED notes only. <code>chargeId=null</code> is already owned by
        overpayment credit notes (credit owed to the payer, excluded from the adjusted total) — there is
        no discriminator today that would let an invoice-level correction coexist with that. Shipping this
        needs one of: (a) drop true invoice-level adjustments, (b) an additive scope marker, or (c) model
        invoice-level debits as a new charge. Nothing below is wired to a write path.
      </Callout>
      <Surface title="Conceptual mock — not implemented">
        <TableWrap>
          <DataTable>
            <TableHead>
              <tr>
                <HeadCell>Description</HeadCell>
                <HeadCell>Applies to</HeadCell>
                <HeadCell className="text-right">Amount</HeadCell>
              </tr>
            </TableHead>
            <tbody>
              <Row>
                <BodyCell>
                  <span className="font-medium text-foreground">Goodwill adjustment</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    No <code>chargeId</code> — not attributable to any single line
                  </span>
                </BodyCell>
                <BodyCell>
                  <Badge variant="outline">Entire invoice</Badge>
                </BodyCell>
                <BodyCell className="text-right tabular-nums text-muted-foreground">RM20.00</BodyCell>
              </Row>
            </tbody>
          </DataTable>
        </TableWrap>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" disabled title="Deferred pending §7-A1 decision">
            Create invoice-level adjustment
          </Button>
        </div>
      </Surface>
    </div>
  );
}

function PreviewStates({ state }: { state: StateId }) {
  switch (state) {
    case "register":
      return <RegisterState />;
    case "invoiceDetail":
      return <DocumentDetailDrawer doc={INVOICE_FINAL} onClose={() => {}} />;
    case "cnDetail":
      return <DocumentDetailDrawer doc={CN_NOTE} onClose={() => {}} />;
    case "dnDetail":
      return <DocumentDetailDrawer doc={DN_NOTE} onClose={() => {}} />;
    case "paidToOutstanding":
      return <DocumentDetailDrawer doc={INVOICE_DN_ONLY} onClose={() => {}} />;
    case "paidToCredit":
      return <DocumentDetailDrawer doc={INVOICE_CN_ONLY} onClose={() => {}} />;
    case "invoiceLevel":
      return <InvoiceLevelDesignOnlyState />;
    default:
      return <IndexNav />;
  }
}

export default function InvoiceAdjustmentsPreviewPage() {
  const [params] = useSearchParams();
  const raw = params.get("state");
  const state = (STATES.some((s) => s.id === raw) ? raw : null) as StateId | null;

  // A dedicated, isolated QueryClient (never the app's real one) seeded with
  // the fixture above and pinned so nothing here ever calls the network.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
            refetchOnMount: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
      }),
  );
  useMemo(() => seedPreviewQueryClient(queryClient), [queryClient]);

  const isOverlay = state !== null && state !== "register" && state !== "invoiceLevel";

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-[var(--page-bg)]">
        {isOverlay && state ? <StateLabel id={state} /> : null}
        {state ? <PreviewStates state={state} /> : <IndexNav />}
      </div>
    </QueryClientProvider>
  );
}
