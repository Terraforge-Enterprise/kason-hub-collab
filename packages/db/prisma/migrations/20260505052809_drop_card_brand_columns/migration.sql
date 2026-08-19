/*
  Warnings:

  - You are about to drop the column `brandName` on the `OrganizationCardSettings` table. All the data in the column will be lost.
  - You are about to drop the column `brandTagline` on the `OrganizationCardSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "OrganizationCardSettings" DROP COLUMN "brandName",
DROP COLUMN "brandTagline";
