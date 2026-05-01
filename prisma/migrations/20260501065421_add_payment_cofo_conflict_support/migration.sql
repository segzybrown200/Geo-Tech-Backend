-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "landStatus" ADD VALUE 'PAYMENT_PENDING';
ALTER TYPE "landStatus" ADD VALUE 'PENDING_REVIEWER_VERIFICATION';

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_landId_fkey";

-- AlterTable
ALTER TABLE "LandRegistration" ADD COLUMN     "conflictFlags" JSONB,
ADD COLUMN     "existingCofODocument" TEXT,
ADD COLUMN     "existingCofOIssueDate" TIMESTAMP(3),
ADD COLUMN     "existingCofONumber" TEXT,
ADD COLUMN     "hasExistingCofO" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requiresReviewerApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'LAND_REGISTRATION',
ALTER COLUMN "landId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LandConflict" (
    "id" UUID NOT NULL,
    "landId" UUID NOT NULL,
    "conflictingLandId" UUID NOT NULL,
    "conflictType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conflictDocument" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LandConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LandConflict_landId_idx" ON "LandConflict"("landId");

-- CreateIndex
CREATE INDEX "LandConflict_conflictingLandId_idx" ON "LandConflict"("conflictingLandId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_landId_fkey" FOREIGN KEY ("landId") REFERENCES "LandRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandConflict" ADD CONSTRAINT "LandConflict_landId_fkey" FOREIGN KEY ("landId") REFERENCES "LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandConflict" ADD CONSTRAINT "LandConflict_conflictingLandId_fkey" FOREIGN KEY ("conflictingLandId") REFERENCES "LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
