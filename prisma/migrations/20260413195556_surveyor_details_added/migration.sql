/*
  Warnings:

  - You are about to drop the column `surveyorLicense` on the `LandRegistration` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LandRegistration" DROP COLUMN "surveyorLicense",
ADD COLUMN     "surveyNotes" TEXT,
ADD COLUMN     "surveyTelephone" TEXT,
ADD COLUMN     "surveyorAddress" TEXT;
