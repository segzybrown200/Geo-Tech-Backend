/*
  Warnings:

  - A unique constraint covering the columns `[applicationNumber]` on the table `OwnershipTransfer` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "OwnershipTransfer" ADD COLUMN     "applicationNumber" TEXT,
ADD COLUMN     "currentReviewerId" UUID,
ADD COLUMN     "revisionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transferAreaSqm" DOUBLE PRECISION,
ADD COLUMN     "transferBearings" JSONB,
ADD COLUMN     "transferCenterLat" DOUBLE PRECISION,
ADD COLUMN     "transferCenterLng" DOUBLE PRECISION,
ADD COLUMN     "transferCoordinates" JSONB,
ADD COLUMN     "transferSurveyType" TEXT,
ADD COLUMN     "transferType" TEXT NOT NULL DEFAULT 'FULL',
ADD COLUMN     "transferUtmZone" TEXT,
ADD COLUMN     "transferredLandId" UUID;

-- CreateTable
CREATE TABLE "TransferStageLog" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "internalUserId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "TransferStageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipTransfer_applicationNumber_key" ON "OwnershipTransfer"("applicationNumber");

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_currentReviewerId_fkey" FOREIGN KEY ("currentReviewerId") REFERENCES "InternalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_transferredLandId_fkey" FOREIGN KEY ("transferredLandId") REFERENCES "LandRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferStageLog" ADD CONSTRAINT "TransferStageLog_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "OwnershipTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferStageLog" ADD CONSTRAINT "TransferStageLog_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
