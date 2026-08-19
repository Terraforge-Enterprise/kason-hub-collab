export type InventorySummary = {
  propertyCount: number;
  unitCount: number;
  occupiedUnits: number;
  vacantUnits: number;
};

export type PropertyListItem = {
  id: string;
  name: string;
  propertyCode: string;
  propertyType: string;
  status: string;
  unitCount: number;
  occupiedUnits: number;
};

export type UnitListItem = {
  id: string;
  propertyId: string;
  propertyName: string;
  unitCode: string;
  unitType: string;
  occupancyStatus: string;
  listingStatus: string;
  rentalRate: number | null;
  currency: string;
};

export type CreatePropertyInput = {
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
};

export type UpdatePropertyInput = Partial<CreatePropertyInput> & {
  propertyId: string;
};

export type CreateUnitInput = {
  propertyId: string;
  unitCode: string;
  unitType: string;
  bedrooms?: number;
  bathrooms?: number;
  rentalRate?: number;
  floor?: number;
};

export type UpdateUnitInput = {
  unitId: string;
  unitCode?: string;
  unitType?: string;
  bedrooms?: number;
  bathrooms?: number;
  rentalRate?: number;
  floor?: number;
  occupancyStatus?: string;
  listingStatus?: string;
};
