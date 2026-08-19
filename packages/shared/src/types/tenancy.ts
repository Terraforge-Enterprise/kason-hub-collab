export type LandlordTenancyListItem = {
  id: string;
  propertyId: string;
  propertyName: string;
  landlordId: string;
  landlordName: string;
  startDate: string;
  endDate: string | null;
  monthlyRent: number;
  depositAmount: number | null;
  status: string;
  notes: string | null;
};

export type TenancyListItem = {
  id: string;
  tenancyCode: string;
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitCode: string;
  tenantPartyId: string;
  tenantName: string;
  status: string;
  billingStatus: string;
  startDate: string;
  endDate: string | null;
  monthlyRentAmount: number;
  previousTenancyId: string | null;
};
