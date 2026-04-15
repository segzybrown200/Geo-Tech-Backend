-- AlterTable
ALTER TABLE "LandRegistration" ADD COLUMN     "startPointLat" DOUBLE PRECISION,
ADD COLUMN     "startPointLng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "OwnershipTransfer" ADD COLUMN     "transferStartPointLat" DOUBLE PRECISION,
ADD COLUMN     "transferStartPointLng" DOUBLE PRECISION;
