-- CreateEnum
CREATE TYPE "ActionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "TransferActionRequest" (
    "id" UUID NOT NULL,
    "landId" UUID NOT NULL,
    "transferId" UUID,
    "requesterId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "ActionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "otpCode" TEXT NOT NULL,
    "otpChannel" TEXT NOT NULL,
    "otpSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "otpExpiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransferActionRequest_landId_idx" ON "TransferActionRequest"("landId");

-- CreateIndex
CREATE INDEX "TransferActionRequest_transferId_idx" ON "TransferActionRequest"("transferId");

-- CreateIndex
CREATE INDEX "TransferActionRequest_requesterId_idx" ON "TransferActionRequest"("requesterId");

-- CreateIndex
CREATE INDEX "TransferActionRequest_ownerId_idx" ON "TransferActionRequest"("ownerId");

-- CreateIndex
CREATE INDEX "TransferActionRequest_status_idx" ON "TransferActionRequest"("status");

-- AddForeignKey
ALTER TABLE "TransferActionRequest" ADD CONSTRAINT "TransferActionRequest_landId_fkey" FOREIGN KEY ("landId") REFERENCES "LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferActionRequest" ADD CONSTRAINT "TransferActionRequest_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "OwnershipTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferActionRequest" ADD CONSTRAINT "TransferActionRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferActionRequest" ADD CONSTRAINT "TransferActionRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
