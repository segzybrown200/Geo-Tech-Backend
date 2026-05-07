-- AlterTable
ALTER TABLE "LandRegistration" ADD COLUMN     "currentReviewerId" UUID;

-- CreateTable
CREATE TABLE "LandReviewLog" (
    "id" UUID NOT NULL,
    "landId" UUID NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "internalUserId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "LandReviewLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "LandRegistration" ADD CONSTRAINT "LandRegistration_currentReviewerId_fkey" FOREIGN KEY ("currentReviewerId") REFERENCES "InternalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandReviewLog" ADD CONSTRAINT "LandReviewLog_landId_fkey" FOREIGN KEY ("landId") REFERENCES "LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LandReviewLog" ADD CONSTRAINT "LandReviewLog_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
