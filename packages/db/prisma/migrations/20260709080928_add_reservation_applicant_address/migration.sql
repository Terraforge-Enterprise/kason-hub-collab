-- AlterTable
ALTER TABLE "UnitReservation" ADD COLUMN     "applicantAddressLine1" TEXT,
ADD COLUMN     "applicantAddressLine2" TEXT,
ADD COLUMN     "applicantCity" TEXT,
ADD COLUMN     "applicantPostcode" TEXT,
ADD COLUMN     "applicantState" TEXT,
ADD COLUMN     "applicantCountry" TEXT;
