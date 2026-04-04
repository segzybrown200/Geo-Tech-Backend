/*
  Warnings:

  - A unique constraint covering the columns `[surveyPlanNumber]` on the table `LandRegistration` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "LandRegistration" ADD COLUMN     "accuracyLevel" TEXT,
ADD COLUMN     "surveyDate" TIMESTAMP(3),
ADD COLUMN     "surveyPlanNumber" TEXT,
ADD COLUMN     "surveyorLicense" TEXT,
ADD COLUMN     "surveyorName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LandRegistration_surveyPlanNumber_key" ON "LandRegistration"("surveyPlanNumber");
