// apps/web/src/pages/billing/v2/create-charge-drawer.tsx
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChargeForm } from "@/components/charge-form";

export function CreateChargeDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Create charge</SheetTitle>
          <SheetDescription>
            Creates a draft. The category routes its document — posting mints the IVTEN/DEP number.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <ChargeForm layout="drawer" onCreated={() => onOpenChange(false)} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
