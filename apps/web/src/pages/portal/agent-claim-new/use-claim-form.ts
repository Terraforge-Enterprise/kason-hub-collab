import { useState, useCallback, useRef, useEffect } from "react";

// ── Types (re-exported so the page can import from one place) ────────────────

export type PropertyUnit = {
  unitCode: string;
  rooms: { id: string; roomType: string; rentalRate: string | null }[];
};

export type PropertyResult = {
  id: string;
  name: string;
  units: PropertyUnit[];
  hasPaxDeduction: boolean;
  paxDeductionAmount: number | null;
};

export type ClaimItemRow = {
  key: string;
  propertyId: string;
  condoName: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string;
  tenantLinkedinUrl: string;
  tenantInstagramHandle: string;
  tenantJobPosition: string;
  tenantIcFrontKey: string;
  tenantIcBackKey: string;
  salesDate: string;
  moveInDate: string;
  moveOutDate: string;
  monthlyRental: string;
  commissionPercentage: string;
  tenancyChargesByAgent: string;
  tenancyChargesByKaen: string;
  numberOfPax: string;
  // From selected property, for calculation:
  hasPaxDeduction: boolean;
  paxDeductionAmount: number;
  hasCobrokeIntent: boolean;
  taSharePercent: string;
  remark?: string;
};

export type FieldError = { itemIndex: number; field: string; message: string };

export type ClaimType = "tenant_portion" | "listing_portion" | "tenant_listing_portion";

// ── Key counter (module-level so keys are unique across mounts) ──────────────

let itemKeyCounter = 0;

export function createEmptyItem(): ClaimItemRow {
  return {
    key: `item-${++itemKeyCounter}`,
    propertyId: "",
    condoName: "",
    unitCode: "",
    roomType: "",
    tenantName: "",
    tenantEmail: "",
    tenantPhone: "",
    tenantLinkedinUrl: "",
    tenantInstagramHandle: "",
    tenantJobPosition: "",
    tenantIcFrontKey: "",
    tenantIcBackKey: "",
    salesDate: "",
    moveInDate: "",
    moveOutDate: "",
    monthlyRental: "",
    commissionPercentage: "",
    tenancyChargesByAgent: "",
    tenancyChargesByKaen: "",
    numberOfPax: "",
    hasPaxDeduction: false,
    paxDeductionAmount: 0,
    hasCobrokeIntent: false,
    taSharePercent: "100",
    remark: "",
  };
}

// ── Pure per-item validator ──────────────────────────────────────────────────
//
// Top-level so it's directly unit-testable and so the hook's `validateForm`
// stays a thin map over items. Returns a list of `FieldError` objects scoped
// to this item's index. Empty list = item is valid.
//
// Note on Commission %: this is the AGENT'S SHARE of the deal's rental
// commission (100 = solo, <100 = jointly negotiated split). It must be
// explicitly entered — there is no default. Cobroke is a separate TA-only
// mechanism via `taSharePercent` and does NOT change this field.
export function validateItem(
  item: ClaimItemRow,
  index: number,
  claimType: ClaimType = "tenant_portion",
): FieldError[] {
  const errors: FieldError[] = [];
  if (!item.condoName)
    errors.push({ itemIndex: index, field: "condoName", message: "Condo is required" });
  if (!item.unitCode)
    errors.push({ itemIndex: index, field: "unitCode", message: "Unit is required" });
  if (!item.roomType)
    errors.push({ itemIndex: index, field: "roomType", message: "Room type is required" });
  if (!item.tenantName.trim())
    errors.push({ itemIndex: index, field: "tenantName", message: "Tenant name is required" });
  if (!item.salesDate)
    errors.push({ itemIndex: index, field: "salesDate", message: "Sales date is required" });
  if (!item.moveInDate)
    errors.push({ itemIndex: index, field: "moveInDate", message: "Move-in date is required" });
  if (!item.moveOutDate)
    errors.push({ itemIndex: index, field: "moveOutDate", message: "Move-out date is required" });
  // Sales must close on or before the tenant moves in. Mirrors the shared-schema
  // check so the agent sees the error inline before submit. ISO YYYY-MM-DD
  // strings are lexicographically ordered, so string compare is safe and
  // timezone-free.
  if (item.salesDate && item.moveInDate && item.salesDate.slice(0, 10) > item.moveInDate.slice(0, 10)) {
    errors.push({
      itemIndex: index,
      field: "salesDate",
      message: "Sales date cannot be after the move-in date",
    });
  }
  // Move-out must be strictly after move-in. Mirrors the shared-schema check.
  if (item.moveInDate && item.moveOutDate && item.moveOutDate.slice(0, 10) <= item.moveInDate.slice(0, 10)) {
    errors.push({
      itemIndex: index,
      field: "moveOutDate",
      message: "Move-out date must be after the move-in date",
    });
  }
  if (!item.monthlyRental || parseFloat(item.monthlyRental) <= 0)
    errors.push({ itemIndex: index, field: "monthlyRental", message: "Monthly rental must be greater than 0" });
  if (!item.commissionPercentage || item.commissionPercentage.trim() === "") {
    errors.push({
      itemIndex: index,
      field: "commissionPercentage",
      message: "Commission % required (enter 100 for solo, or your negotiated share)",
    });
  } else {
    const pct = parseFloat(item.commissionPercentage);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      errors.push({ itemIndex: index, field: "commissionPercentage", message: "Commission must be 0-100%" });
    }
  }
  // Listing-portion claims are passive income for the listing agent — TA
  // charges come from the tenant-side claim. Skip the required guards so
  // the agent can submit with 0/empty values. Server mirrors this exemption.
  if (claimType !== "listing_portion") {
    if (!item.tenancyChargesByAgent && item.tenancyChargesByAgent !== "0")
      errors.push({ itemIndex: index, field: "tenancyChargesByAgent", message: "Charges by agent is required" });
    if (!item.tenancyChargesByKaen)
      errors.push({ itemIndex: index, field: "tenancyChargesByKaen", message: "KAEN charges is required" });
  }
  if (
    item.hasPaxDeduction &&
    (!item.numberOfPax || parseInt(item.numberOfPax) <= 0)
  ) {
    errors.push({ itemIndex: index, field: "numberOfPax", message: "Number of pax is required for this condo" });
  }
  return errors;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useClaimForm() {
  // ── Core form state ────────────────────────────────────────────────────────
  const [claimType, setClaimType] = useState<ClaimType>("tenant_portion");
  const [items, setItems] = useState<ClaimItemRow[]>([createEmptyItem()]);
  const [selectedProperties, setSelectedProperties] = useState<
    Map<string, PropertyResult>
  >(new Map());
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [submitBlockedError, setSubmitBlockedError] = useState<string | null>(
    null,
  );
  // Keep a ref to current items so validateForm (stable callback) can always
  // read the latest value without re-creating on every render.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const claimTypeRef = useRef(claimType);
  useEffect(() => {
    claimTypeRef.current = claimType;
  }, [claimType]);

  // ── Item actions ───────────────────────────────────────────────────────────

  const updateItem = useCallback(
    (
      index: number,
      field: keyof ClaimItemRow,
      value: string | boolean | number,
    ) => {
      setItems((prev) =>
        prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
      );
    },
    [],
  );

  const addItem = useCallback(
    () => setItems((prev) => [...prev, createEmptyItem()]),
    [],
  );

  const removeItem = useCallback((index: number) => {
    setItems((prev) => {
      if (prev.length <= 1) return prev;
      const removedKey = prev[index].key;
      setSelectedProperties((sp) => {
        const next = new Map(sp);
        next.delete(removedKey);
        return next;
      });
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handlePropertySelect = useCallback(
    (index: number, property: PropertyResult) => {
      setItems((prev) => {
        const itemKey = prev[index].key;
        setSelectedProperties((sp) => new Map(sp).set(itemKey, property));
        return prev.map((item, i) =>
          i === index
            ? {
                ...item,
                propertyId: property.id,
                condoName: property.name,
                unitCode: "",
                roomType: "",
                hasPaxDeduction: property.hasPaxDeduction,
                paxDeductionAmount: property.paxDeductionAmount ?? 0,
                numberOfPax: "",
              }
            : item,
        );
      });
    },
    [],
  );

  // ── Validation helpers ─────────────────────────────────────────────────────

  // Reads from itemsRef so this callback stays stable (empty dep array) while
  // always seeing the latest items value.
  const validateForm = useCallback((): FieldError[] => {
    const ct = claimTypeRef.current;
    return itemsRef.current.flatMap((item, index) => validateItem(item, index, ct));
  }, []);

  const hasError = useCallback(
    (itemIndex: number, field: string): boolean =>
      fieldErrors.some((e) => e.itemIndex === itemIndex && e.field === field),
    [fieldErrors],
  );

  const getError = useCallback(
    (itemIndex: number, field: string): string | undefined =>
      fieldErrors.find((e) => e.itemIndex === itemIndex && e.field === field)
        ?.message,
    [fieldErrors],
  );

  const clearError = useCallback((itemIndex: number, field: string) => {
    setFieldErrors((prev) =>
      prev.filter(
        (err) => !(err.itemIndex === itemIndex && err.field === field),
      ),
    );
  }, []);

  // ── Payload builder ────────────────────────────────────────────────────────

  // Accepts claimType + items as arguments so the caller passes the current
  // values — avoids stale-closure issues on a stable callback.
  const buildPayload = useCallback(
    (currentClaimType: ClaimType, currentItems: ClaimItemRow[]) => ({
      claimType: currentClaimType,
      items: currentItems.map((item) => ({
        propertyId: item.propertyId || undefined,
        condoName: item.condoName || undefined,
        unitCode: item.unitCode || undefined,
        roomType: item.roomType || undefined,
        tenantName: item.tenantName || undefined,
        tenantEmail: item.tenantEmail || undefined,
        tenantPhone: item.tenantPhone || undefined,
        tenantLinkedinUrl: item.tenantLinkedinUrl || undefined,
        tenantInstagramHandle: item.tenantInstagramHandle || undefined,
        tenantJobPosition: item.tenantJobPosition || undefined,
        tenantIcFrontKey: item.tenantIcFrontKey || undefined,
        tenantIcBackKey: item.tenantIcBackKey || undefined,
        salesDate: item.salesDate || undefined,
        moveInDate: item.moveInDate || undefined,
        moveOutDate: item.moveOutDate || undefined,
        monthlyRental: item.monthlyRental || undefined,
        commissionPercentage: item.commissionPercentage || undefined,
        tenancyChargesByAgent: item.tenancyChargesByAgent || undefined,
        tenancyChargesByKaen: item.tenancyChargesByKaen || undefined,
        ...(item.hasPaxDeduction && item.numberOfPax
          ? { numberOfPax: parseInt(item.numberOfPax, 10) }
          : {}),
        hasCobrokeIntent: item.hasCobrokeIntent,
        taSharePercent: item.taSharePercent || undefined,
        remark: item.remark?.trim() || undefined,
      })),
    }),
    [],
  );

  // ── Return shape ───────────────────────────────────────────────────────────

  return {
    state: {
      claimType,
      items,
      selectedProperties,
      fieldErrors,
      submitBlockedError,
    },
    actions: {
      // Direct setters (exposed for hydration + handleFormError in the page)
      setClaimType,
      setItems,
      setSelectedProperties,
      setFieldErrors,
      setSubmitBlockedError,
      // Item CRUD
      addItem,
      removeItem,
      updateItem,
      handlePropertySelect,
      // Validation
      validateForm,
      hasError,
      getError,
      clearError,
      // Payload
      buildPayload,
    },
  };
}
