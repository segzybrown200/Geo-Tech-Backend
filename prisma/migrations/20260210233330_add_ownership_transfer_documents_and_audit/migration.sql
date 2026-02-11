/*
  Warnings:

  - You are about to drop the column `documents` on the `OwnershipTransfer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "OwnershipTransfer" DROP COLUMN "documents",
ADD COLUMN     "governorComment" TEXT,
ADD COLUMN     "governorId" UUID,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OwnershipTransferDocument" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipTransferDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipTransferAuditLog" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "performedById" UUID,
    "performedByRole" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipTransferAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnershipTransferDocument_transferId_idx" ON "OwnershipTransferDocument"("transferId");

-- CreateIndex
CREATE INDEX "OwnershipTransferDocument_status_idx" ON "OwnershipTransferDocument"("status");

-- CreateIndex
CREATE INDEX "OwnershipTransferAuditLog_transferId_idx" ON "OwnershipTransferAuditLog"("transferId");

-- CreateIndex
CREATE INDEX "OwnershipTransferAuditLog_createdAt_idx" ON "OwnershipTransferAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_governorId_idx" ON "OwnershipTransfer"("governorId");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_createdAt_idx" ON "OwnershipTransfer"("createdAt");

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_governorId_fkey" FOREIGN KEY ("governorId") REFERENCES "InternalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransferDocument" ADD CONSTRAINT "OwnershipTransferDocument_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "OwnershipTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransferAuditLog" ADD CONSTRAINT "OwnershipTransferAuditLog_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "OwnershipTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
