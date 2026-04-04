/*
  Warnings:

  - You are about to drop the column `latitude` on the `LandRegistration` table. All the data in the column will be lost.
  - You are about to drop the column `longitude` on the `LandRegistration` table. All the data in the column will be lost.
  - You are about to drop the column `squareMeters` on the `LandRegistration` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[landCode]` on the table `LandRegistration` will be added. If there are existing duplicate values, this will fail.
  - Made the column `boundary` on table `LandRegistration` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "LandRegistration" DROP COLUMN "latitude",
DROP COLUMN "longitude",
DROP COLUMN "squareMeters",
ADD COLUMN     "areaSqm" DOUBLE PRECISION,
ADD COLUMN     "landCode" TEXT,
ADD COLUMN     "parentLandId" UUID,
ALTER COLUMN "boundary" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "LandRegistration_landCode_key" ON "LandRegistration"("landCode");

-- CreateIndex
CREATE INDEX "LandRegistration_ownerId_idx" ON "LandRegistration"("ownerId");

-- CreateIndex
CREATE INDEX "LandRegistration_stateId_idx" ON "LandRegistration"("stateId");

-- CreateIndex
CREATE INDEX "LandRegistration_landStatus_idx" ON "LandRegistration"("landStatus");

-- AddForeignKey
ALTER TABLE "LandRegistration" ADD CONSTRAINT "LandRegistration_parentLandId_fkey" FOREIGN KEY ("parentLandId") REFERENCES "LandRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandAuditLog" ADD CONSTRAINT "LandAuditLog_landId_fkey" FOREIGN KEY ("landId") REFERENCES "LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
