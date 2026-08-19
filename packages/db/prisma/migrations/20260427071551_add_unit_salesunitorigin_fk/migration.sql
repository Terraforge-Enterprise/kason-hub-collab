-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_salesUnitOriginId_fkey" FOREIGN KEY ("salesUnitOriginId") REFERENCES "SalesUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
