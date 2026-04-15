-- AlterEnum
ALTER TYPE "TransferStatus" ADD VALUE 'DOCUMENTS_UPLOADED';

-- AlterTable
ALTER TABLE "OwnershipTransferDocument" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" UUID;

-- AddForeignKey
ALTER TABLE "OwnershipTransferDocument" ADD CONSTRAINT "OwnershipTransferDocument_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "InternalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
