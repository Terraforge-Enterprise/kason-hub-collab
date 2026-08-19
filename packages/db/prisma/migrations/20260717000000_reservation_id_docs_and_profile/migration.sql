-- AlterTable
ALTER TABLE "UnitReservation" ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "emergencyContactRelation" TEXT,
ADD COLUMN     "monthlyIncome" DECIMAL(12,2),
ADD COLUMN     "nationality" TEXT,
ADD COLUMN     "occupation" TEXT;

-- CreateTable
CREATE TABLE "UnitReservationDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitReservationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitReservationDocument_reservationId_idx" ON "UnitReservationDocument"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitReservationDocument_reservationId_kind_key" ON "UnitReservationDocument"("reservationId", "kind");

-- AddForeignKey
ALTER TABLE "UnitReservationDocument" ADD CONSTRAINT "UnitReservationDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitReservationDocument" ADD CONSTRAINT "UnitReservationDocument_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "UnitReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no access policy defined — the Hono API
-- connects with the Supabase service-role key; RLS is defense-in-depth vs
-- direct anon access). Matches every other Phase-2 table.
ALTER TABLE "UnitReservationDocument" ENABLE ROW LEVEL SECURITY;
