-- AlterTable
ALTER TABLE "LandRegistration" ADD COLUMN     "centerLat" DOUBLE PRECISION,
ADD COLUMN     "centerLng" DOUBLE PRECISION,
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false;
