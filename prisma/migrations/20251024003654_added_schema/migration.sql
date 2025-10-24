-- CreateEnum
CREATE TYPE "public"."ApplicationStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('USER', 'APPROVER', 'ADMIN', 'GOVERNOR');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "fullName" TEXT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Application" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "public"."ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InternalUser" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "phone" TEXT,
    "ministry" TEXT,
    "department" TEXT,
    "position" TEXT,
    "function" TEXT,
    "stateId" UUID NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'APPROVER',
    "requiresSignature" BOOLEAN NOT NULL DEFAULT false,
    "signatureUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailToken" TEXT,
    "passwordToken" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "tokenExpiresAt" TIMESTAMP(3),

    CONSTRAINT "InternalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "internalUserId" UUID NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InternalOtp" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "internalUserId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LandRegistration" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "ownerName" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "squareMeters" DOUBLE PRECISION NOT NULL,
    "ownershipType" TEXT NOT NULL,
    "stateId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "titleType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boundary" geometry,

    CONSTRAINT "LandRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LandDocument" (
    "id" TEXT NOT NULL,
    "landId" UUID NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,

    CONSTRAINT "LandDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."State" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "boundary" geometry,
    "governorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OwnershipHistory" (
    "id" UUID NOT NULL,
    "landId" UUID NOT NULL,
    "previousOwner" TEXT NOT NULL,
    "newOwner" TEXT NOT NULL,
    "dateChanged" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CofOApplication" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "landId" UUID NOT NULL,
    "status" "public"."ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "documentUrls" TEXT[],
    "paymentRef" TEXT,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "cofONumber" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governorSignatureUrl" TEXT,

    CONSTRAINT "CofOApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StageLog" (
    "id" UUID NOT NULL,
    "cofOId" UUID NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "internalUserId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "StageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InboxMessage" (
    "id" TEXT NOT NULL,
    "receiverId" UUID NOT NULL,
    "cofOId" UUID NOT NULL,
    "documentList" TEXT[],
    "status" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageLink" TEXT NOT NULL,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EmailVerificationToken" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "InternalUser_email_key" ON "public"."InternalUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshToken_key" ON "public"."Session"("refreshToken");

-- CreateIndex
CREATE UNIQUE INDEX "State_name_key" ON "public"."State"("name");

-- CreateIndex
CREATE UNIQUE INDEX "State_governorId_key" ON "public"."State"("governorId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_token_key" ON "public"."EmailVerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "public"."PasswordResetToken"("token");

-- AddForeignKey
ALTER TABLE "public"."Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InternalUser" ADD CONSTRAINT "InternalUser_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "public"."State"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "public"."InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InternalOtp" ADD CONSTRAINT "InternalOtp_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "public"."InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LandRegistration" ADD CONSTRAINT "LandRegistration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LandRegistration" ADD CONSTRAINT "LandRegistration_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "public"."State"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LandDocument" ADD CONSTRAINT "LandDocument_landId_fkey" FOREIGN KEY ("landId") REFERENCES "public"."LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."State" ADD CONSTRAINT "State_governorId_fkey" FOREIGN KEY ("governorId") REFERENCES "public"."InternalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OwnershipHistory" ADD CONSTRAINT "OwnershipHistory_landId_fkey" FOREIGN KEY ("landId") REFERENCES "public"."LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CofOApplication" ADD CONSTRAINT "CofOApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CofOApplication" ADD CONSTRAINT "CofOApplication_landId_fkey" FOREIGN KEY ("landId") REFERENCES "public"."LandRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageLog" ADD CONSTRAINT "StageLog_cofOId_fkey" FOREIGN KEY ("cofOId") REFERENCES "public"."CofOApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageLog" ADD CONSTRAINT "StageLog_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "public"."InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InboxMessage" ADD CONSTRAINT "InboxMessage_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "public"."InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InboxMessage" ADD CONSTRAINT "InboxMessage_cofOId_fkey" FOREIGN KEY ("cofOId") REFERENCES "public"."CofOApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
