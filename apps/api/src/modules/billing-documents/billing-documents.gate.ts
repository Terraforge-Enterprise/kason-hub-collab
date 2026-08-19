// apps/api/src/modules/billing-documents/billing-documents.gate.ts
//
// Reuse-before-create (spec §4.8 reuse manifest: "Implementers MUST reuse
// before creating"). Plan 1 Task 7 already produced `billingDocsFlagGate`
// (apps/api/src/modules/charge-categories/billing-docs.gate.ts) specifically
// so this module could reuse it — see plan doc
// docs/superpowers/plans/2026-07-02-accounting-p1-foundation.md:896
// ("Produces: billingDocsFlagGate ... reused by Plan 2's billing-documents
// module"). A second flag-check middleware would duplicate the
// ENABLE_PHASE2_BILLING_DOCS gate logic for no benefit; this file just
// re-exports the canonical instance under this module's own path so
// Task 5+'s routes.ts can `import { billingDocsFlagGate } from
// "./billing-documents.gate"` per the Interfaces contract.
export { billingDocsFlagGate } from "../charge-categories/billing-docs.gate";
