/*
  Warnings:

  - You are about to drop the column `startPointLat` on the `LandRegistration` table. All the data in the column will be lost.
  - You are about to drop the column `startPointLng` on the `LandRegistration` table. All the data in the column will be lost.
  - You are about to drop the column `transferStartPointLat` on the `OwnershipTransfer` table. All the data in the column will be lost.
  - You are about to drop the column `transferStartPointLng` on the `OwnershipTransfer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LandRegistration" DROP COLUMN "startPointLat",
DROP COLUMN "startPointLng",
ADD COLUMN     "startPoint" JSONB;

-- AlterTable
ALTER TABLE "OwnershipTransfer" DROP COLUMN "transferStartPointLat",
DROP COLUMN "transferStartPointLng",
ADD COLUMN     "transferStartPoint" JSONB;
