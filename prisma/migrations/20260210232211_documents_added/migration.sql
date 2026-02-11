/*
  Warnings:

  - The `status` column on the `OwnershipTransfer` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[transferId,target]` on the table `TransferVerification` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `fromUserId` on the `OwnershipHistory` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `toUserId` on the `OwnershipHistory` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `authorizedBy` on the `OwnershipHistory` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('INITIATED', 'VERIFIED_BY_PARTIES', 'PENDING_GOVERNOR', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "OwnershipHistory" DROP COLUMN "fromUserId",
ADD COLUMN     "fromUserId" UUID NOT NULL,
DROP COLUMN "toUserId",
ADD COLUMN     "toUserId" UUID NOT NULL,
DROP COLUMN "authorizedBy",
ADD COLUMN     "authorizedBy" UUID NOT NULL;

-- AlterTable
ALTER TABLE "OwnershipTransfer" ADD COLUMN     "documents" JSONB,
ADD COLUMN     "newOwnerId" UUID,
ADD COLUMN     "newOwnerPhone" TEXT,
ALTER COLUMN "newOwnerEmail" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "TransferStatus" NOT NULL DEFAULT 'INITIATED';

-- CreateIndex
CREATE INDEX "OwnershipHistory_landId_idx" ON "OwnershipHistory"("landId");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_status_idx" ON "OwnershipTransfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TransferVerification_transferId_target_key" ON "TransferVerification"("transferId", "target");

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_newOwnerId_fkey" FOREIGN KEY ("newOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
