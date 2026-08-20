// Compatibility shim. The unit typeahead now lives in the shared component
// `@/components/unit-picker` (so the meter + owner drawers reuse it instead of
// re-implementing a "type a UUID" field). UnitPicker is a drop-in for the old
// UnitTypeahead (identical props), so this re-export keeps existing imports —
// and the tasks drawer — working without churn.
export { UnitPicker as UnitTypeahead, ApartmentPicker } from "@/components/unit-picker";
