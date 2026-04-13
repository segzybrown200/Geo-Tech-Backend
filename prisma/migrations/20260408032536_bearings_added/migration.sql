/*
  Warnings:

  - You are about to drop the column `coordinates` on the `LandRegistration` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LandRegistration" DROP COLUMN "coordinates",
ADD COLUMN     "bearings" JSONB,
ADD COLUMN     "latlngCoordinates" JSONB,
ADD COLUMN     "surveyType" TEXT,
ADD COLUMN     "utmCoordinates" JSONB,
ADD COLUMN     "utmZone" TEXT;
