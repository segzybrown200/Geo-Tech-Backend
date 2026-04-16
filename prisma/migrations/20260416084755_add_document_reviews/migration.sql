-- CreateTable
CREATE TABLE "DocumentReview" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "status" "DocumentStatus" NOT NULL,
    "rejectionMessage" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentReview_documentId_idx" ON "DocumentReview"("documentId");

-- CreateIndex
CREATE INDEX "DocumentReview_reviewerId_idx" ON "DocumentReview"("reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentReview_documentId_reviewerId_key" ON "DocumentReview"("documentId", "reviewerId");

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OwnershipTransferDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
