-- T2: UnitReservation.tenantPartyId -- link recording which tenant Party a
-- signed reservation was used to create. Set once (conditional write, WHERE
-- tenantPartyId IS NULL) by a later task; drives the "has reservation" tag.
-- Nullable + additive; second Party<->UnitReservation relation, distinct
-- from the existing ReservationIssuer relation (issuedByPartyId).
--
-- ON DELETE SET NULL: deleting the tenant Party unlinks the reservation
-- rather than deleting or blocking it -- the reservation row (and its signed
-- PDF, deposits, transitions) is the durable audit trail and must survive a
-- Party deletion.
ALTER TABLE "UnitReservation" ADD COLUMN "tenantPartyId" uuid;
ALTER TABLE "UnitReservation"
  ADD CONSTRAINT "UnitReservation_tenantPartyId_fkey"
  FOREIGN KEY ("tenantPartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "unitreservation_tenantparty" ON "UnitReservation" ("organizationId", "tenantPartyId");
