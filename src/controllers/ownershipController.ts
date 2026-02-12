import prisma from "../lib/prisma";
import crypto from "crypto";
import { Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";
import { sendEmail } from "../services/emailSevices";
import { uploadToCloudinary, validateDocumentFile } from "../services/uploadService";

/* ===============================
   1. INITIATE OWNERSHIP TRANSFER
================================ */

export const initiateOwnershipTransfer = async (
  req: AuthRequest,
  res: Response
) => {
  const ownerId = req.user.sub;
  const { landId, newOwnerEmail, newOwnerPhone, emails = [], phones = [] } = req.body;

  try {
    // Validate land ownership
    const land = await prisma.landRegistration.findUnique({
      where: { id: landId },
      include: { owner: true },
    });

    if (!land || land.ownerId !== ownerId) {
      return res.status(403).json({ message: "You don't own this land" });
    }

    // Verify at least one email or phone is provided
    if (!newOwnerEmail && !newOwnerPhone) {
      return res.status(400).json({
        message: "Either email or phone is required for new owner",
      });
    }

    // Check if new owner exists or will be identified by email/phone
    const existingOwner = await prisma.user.findFirst({
      where: {
        OR: [
          { email: newOwnerEmail ?? undefined },
          { phone: newOwnerPhone ?? undefined },
        ],
      },
    });

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Create transfer record
    const transfer = await prisma.ownershipTransfer.create({
      data: {
        landId,
        currentOwnerId: ownerId,
        newOwnerEmail,
        newOwnerPhone,
        expiresAt,
      },
    });

    // Create verification records for each channel
    // Include new owner's primary email/phone PLUS any additional emails/phones provided
    const channels = [
      ...emails.map((e: string) => ({ type: "email", value: e })),
      ...phones.map((p: string) => ({ type: "phone", value: p })),
      ...(newOwnerEmail ? [{ type: "email", value: newOwnerEmail }] : []),
      ...(newOwnerPhone ? [{ type: "phone", value: newOwnerPhone }] : []),
    ];

    // Remove duplicates
    const uniqueChannels = Array.from(
      new Map(channels.map(c => [c.value, c])).values()
    );

    const verificationRecords = [];
    const verificationCodes: Record<string, string> = {};

    for (const channel of uniqueChannels) {
      const code = crypto.randomInt(100000, 999999).toString();
      verificationCodes[channel.value] = code;

      verificationRecords.push({
        transferId: transfer.id,
        channelType: channel.type,
        target: channel.value,
        code,
        expiresAt,
      });

      // Send verification code
      if (channel.type === "email") {
        await sendEmail(
          channel.value,
          "Land Ownership Transfer - Verification Code",
          `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 8px;">
            <div style="background: #004CFF; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
              <h2>Land Ownership Transfer Request</h2>
            </div>
            <div style="padding: 20px;">
              <p>Dear Recipient,</p>
              <p>A land ownership transfer has been initiated. To verify your identity and proceed with the transfer, please use the code below:</p>
              <div style="background: #f5f5f5; padding: 15px; text-align: center; border-radius: 5px; margin: 20px 0;">
                <p style="font-size: 24px; font-weight: bold; color: #004CFF; margin: 0;">${code}</p>
              </div>
              <p><strong>This code expires in 15 minutes.</strong></p>
              <p>Land Details:<br/>
              Owner: ${land.ownerName}<br/>
              Location: ${land.address || `${land.latitude}, ${land.longitude}`}<br/>
              Size: ${land.squareMeters}m²
              </p>
              <p style="color: #666; font-size: 12px; margin-top: 30px;">
                If you did not request this transfer, please ignore this email or contact support immediately.
              </p>
            </div>
          </div>
          `
        );
      } else {
        // For SMS, log it (integrate SMS service as needed)
        console.log(`SMS to ${channel.value}: Your verification code is ${code}. Valid for 15 minutes.`);
      }
    }

    // Batch create verification records
    await prisma.transferVerification.createMany({
      data: verificationRecords,
    });

    // Create audit log for transfer initiation
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId: transfer.id,
        action: "INITIATED",
        performedById: ownerId,
        performedByRole: "USER",
        comment: `Transfer initiated for land ${landId}`,
      },
    });

    // Notify current owner
    const currentOwner = land.owner;
    if (currentOwner?.email) {
      await sendEmail(
        currentOwner.email,
        "Land Ownership Transfer Initiated",
        `
        <div style="font-family: Arial, sans-serif;">
          <p>Hello ${currentOwner.fullName},</p>
          <p>You have initiated a land ownership transfer.</p>
          <p><strong>Transfer ID:</strong> ${transfer.id}</p>
          <p><strong>New Owner:</strong> ${newOwnerEmail || newOwnerPhone}</p>
          <p>Verification codes have been sent to the provided contacts.</p>
          <p>Once all parties verify, the transfer will be submitted to the governor for approval.</p>
        </div>
        `
      );
    }

    res.status(201).json({
      message: "Ownership transfer initiated successfully",
      transferId: transfer.id,
      expiresAt,
      verificationChannels: channels.length,
    });
  } catch (err) {
    console.error("Transfer initiation error:", err);
    res.status(500).json({ message: "Transfer initiation failed", error: String(err) });
  }
};

/* ===============================
   2. VERIFY OTP CODE
================================ */

export const verifyTransferOTP = async (req: AuthRequest, res: Response) => {
  const userId = req.user.sub;
  const { transferId, target, code } = req.body;

  try {
    if (!transferId || !target || !code) {
      return res.status(400).json({
        message: "transferId, target, and code are required",
      });
    }

    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { verifications: true },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Verify the user is authorized to verify this target.
    // Allowed: current owner, the transfer's new-owner contact, or a registered user whose email/phone matches the target.
    const isCurrentOwner = transfer.currentOwnerId === userId;
    const isNewOwnerContact = transfer.newOwnerEmail === target || transfer.newOwnerPhone === target;

    // Attempt to load the requesting user's contact info (may be undefined for some auth flows)
    let requestingUser: any = null;
    try {
      requestingUser = await prisma.user.findUnique({ where: { id: userId } });
    } catch (e) {
      requestingUser = null;
    }

    const isRequestingUserTarget = Boolean(
      requestingUser && (requestingUser.email === target || requestingUser.phone === target)
    );

    if (!isCurrentOwner && !isNewOwnerContact && !isRequestingUserTarget) {
      return res.status(403).json({ message: "You are not authorized to verify this transfer" });
    }

    // Find the verification record
    const verificationRecord = await prisma.transferVerification.findFirst({
      where: { transferId, target },
    });

    if (!verificationRecord) {
      return res.status(404).json({
        message: "Verification record not found for this target",
      });
    }

    if (verificationRecord.isVerified) {
      return res.status(400).json({ message: "This channel is already verified" });
    }

    if (verificationRecord.code !== code) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    if (new Date() > verificationRecord.expiresAt) {
      return res.status(400).json({ message: "Verification code has expired" });
    }

    // Mark as verified
    await prisma.transferVerification.update({
      where: { id: verificationRecord.id },
      data: { isVerified: true },
    });

    // Check if all verifications are complete
    const unverifiedCount = await prisma.transferVerification.count({
      where: { transferId, isVerified: false },
    });

    const transferUpdated = unverifiedCount === 0
      ? await prisma.ownershipTransfer.update({
          where: { id: transferId },
          data: { status: "VERIFIED_BY_PARTIES" },
        })
      : transfer;

    // Create audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId,
        action: "OTP_VERIFIED",
        performedById: userId,
        performedByRole: "USER",
        comment: `Verified by ${target}`,
      },
    });

    // Notify current owner if all parties verified
    if (unverifiedCount === 0) {
      const currentOwner = await prisma.user.findUnique({
        where: { id: transfer.currentOwnerId },
      });

      if (currentOwner?.email) {
        await sendEmail(
          currentOwner.email,
          "Land Ownership Transfer - All Parties Verified",
          `
          <div style="font-family: Arial, sans-serif;">
            <p>Hello ${currentOwner.fullName},</p>
            <p>All parties have verified the land ownership transfer request.</p>
            <p>You may now proceed to submit the required documents for governor approval.</p>
            <p><strong>Transfer ID:</strong> ${transferId}</p>
          </div>
          `
        );
      }
    }

    res.json({
      message: "Verification successful",
      verified: true,
      allPartiesVerified: unverifiedCount === 0,
      remainingVerifications: unverifiedCount,
    });
  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ message: "Verification failed", error: String(err) });
  }
};

/* ===============================
   3. SUBMIT DOCUMENTS FOR REVIEW (with Cloudinary upload)
================================ */

export const submitTransferDocuments = async (
  req: AuthRequest,
  res: Response
) => {
  const ownerId = req.user.sub;
  const { transferId } = req.body;
  const files = req.files as Express.Multer.File[];

  try {
    if (!transferId) {
      return res.status(400).json({ message: "Transfer ID is required" });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No documents provided" });
    }

    // Get transfer details
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { land: { include: { state: true } } },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    if (transfer.currentOwnerId !== ownerId) {
      return res.status(403).json({
        message: "Only the current owner can submit documents",
      });
    }

    if (transfer.status !== "VERIFIED_BY_PARTIES") {
      return res.status(400).json({
        message: "All parties must verify before submitting documents",
      });
    }

    // Validate all files
    const validationErrors: string[] = [];
    files.forEach((file, index) => {
      const validation = validateDocumentFile(
        file.buffer,
        file.originalname,
        file.mimetype
      );
      if (!validation.valid) {
        validationErrors.push(`File ${index + 1}: ${validation.error}`);
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        message: "Document validation failed",
        errors: validationErrors,
      });
    }

    // Parse document metadata
    const documentsMeta: Array<{
      type: string;
      title: string;
    }> = JSON.parse(req.body.documentsMeta || "[]");

    if (documentsMeta.length !== files.length) {
      return res.status(400).json({
        message: "Documents metadata must match uploaded files count",
      });
    }

    // Upload all documents to Cloudinary and create records
    const uploadResults = await Promise.all(
      files.map((file) =>
        uploadToCloudinary(file.buffer, file.originalname, file.mimetype, {
          folder: `geotech_ownership_transfers/${transferId}`,
          resourceType: file.mimetype.startsWith("image/") ? "image" : "raw",
        })
      )
    );

    // Create document records in transaction
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < uploadResults.length; i++) {
        await tx.ownershipTransferDocument.create({
          data: {
            transferId,
            type: documentsMeta[i].type,
            title: documentsMeta[i].title,
            url: uploadResults[i].secure_url,
            status: "PENDING",
          },
        });
      }

      // Update transfer status
      await tx.ownershipTransfer.update({
        where: { id: transferId },
        data: { status: "PENDING_GOVERNOR" },
      });

      // Create audit log
      await tx.ownershipTransferAuditLog.create({
        data: {
          transferId,
          action: "DOCUMENTS_SUBMITTED",
          performedById: ownerId,
          performedByRole: "USER",
          comment: `Submitted ${files.length} document(s) for governor review`,
        },
      });
    });

    // Find governor and notify
    const governor = await prisma.internalUser.findFirst({
      where: {
        role: "GOVERNOR",
        stateId: transfer.land.stateId,
      },
    });

    if (governor?.email) {
      await sendEmail(
        governor.email,
        "Land Ownership Transfer - Documents Submitted for Review",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
          <div style="background: #004CFF; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2>Ownership Transfer Submitted for Review</h2>
          </div>
          <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
            <p>Hello Governor ${governor.name},</p>
            <p>A land ownership transfer has been submitted for your review and approval.</p>
            <p><strong>Transfer Details:</strong></p>
            <ul>
              <li>Transfer ID: ${transferId}</li>
              <li>Land: ${transfer.land.address || `${transfer.land.latitude}, ${transfer.land.longitude}`}</li>
              <li>Land Size: ${transfer.land.squareMeters}m²</li>
              <li>Documents Submitted: ${files.length}</li>
            </ul>
            <p>Please review the submitted documents and either approve or reject the transfer.</p>
            <p style="color: #666; font-size: 12px; margin-top: 30px;">
              This is an automated message from the GeoTech system.
            </p>
          </div>
        </div>
        `
      );
    }

    res.status(201).json({
      message: "Documents submitted successfully to governor for review",
      transferId,
      documentsCount: files.length,
    });
  } catch (err) {
    console.error("Document submission error:", err);
    res.status(500).json({ message: "Document submission failed", error: String(err) });
  }
};

/* ===============================
   4. GOVERNOR REVIEWS TRANSFER
================================ */

export const getTransferForReview = async (
  req: AuthRequest,
  res: Response
) => {
  const governorId = req.user.id;
  const { transferId } = req.params;

  try {
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
    });

    if (!governor || governor.role !== "GOVERNOR") {
      return res.status(403).json({ message: "Governor access required" });
    }

    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId, land: { state: { governorId } } },
      include: {
        land: { include: { state: true } },
        documents: true,
        currentOwner: true,
        verifications: {
          select: { target: true, channelType: true, isVerified: true },
        },
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Ensure governor can only review transfers in their state
    if (transfer.land.state.governorId !== governorId) {
      return res.status(403).json({
        message: "You can only review transfers in your state",
      });
    }

    res.json({ transfer });
  } catch (err) {
    console.error("Review fetch error:", err);
    res.status(500).json({ message: "Failed to retrieve transfer", error: String(err) });
  }
};

/* ===============================
   5. GOVERNOR APPROVES TRANSFER
================================ */

export const approveOwnershipTransfer = async (
  req: AuthRequest,
  res: Response
) => {
  const governorId = req.user.id;
  const { transferId } = req.params;
  const { governorComment } = req.body;

  try {
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
    });

    if (!governor || governor.role !== "GOVERNOR") {
      return res.status(403).json({ message: "Governor access required" });
    }

    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: { include: { state: true, owner: true } },
        documents: true,
        currentOwner: true,
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    if (transfer.land.state.governorId !== governorId) {
      return res.status(403).json({
        message: "You can only approve transfers in your state",
      });
    }

    if (transfer.status !== "PENDING_GOVERNOR") {
      return res.status(400).json({
        message: `Transfer cannot be approved in ${transfer.status} status`,
      });
    }

    // Find or verify new owner
    let newOwner = await prisma.user.findFirst({
      where: {
        OR: [
          { email: transfer.newOwnerEmail ?? undefined },
          { phone: transfer.newOwnerPhone ?? undefined },
        ],
      },
    });

    if (!newOwner) {
      return res.status(404).json({
        message: "New owner not found in system. They must register first.",
      });
    }

    // Execute transfer in transaction
    await prisma.$transaction(async (tx) => {
      // Update land ownership
      await tx.landRegistration.update({
        where: { id: transfer.landId },
        data: { ownerId: newOwner!.id },
      });

      // Create ownership history
      await tx.ownershipHistory.create({
        data: {
          landId: transfer.landId,
          fromUserId: transfer.currentOwnerId,
          toUserId: newOwner!.id,
          authorizedBy: governorId,
        },
      });

      // Mark all documents as approved
      await tx.ownershipTransferDocument.updateMany({
        where: { transferId },
        data: { status: "APPROVED" },
      });

      // Update transfer
      await tx.ownershipTransfer.update({
        where: { id: transferId },
        data: {
          status: "APPROVED",
          newOwnerId: newOwner!.id,
          governorId,
          reviewedAt: new Date(),
          governorComment,
        },
      });

      // Create audit log
      await tx.ownershipTransferAuditLog.create({
        data: {
          transferId,
          action: "APPROVED",
          performedById: governorId,
          performedByRole: "GOVERNOR",
          comment: governorComment || "Transfer approved by governor",
        },
      });
    });

    // Send approval emails
    if (transfer.currentOwner?.email) {
      await sendEmail(
        transfer.currentOwner.email,
        "Land Ownership Transfer - APPROVED",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
          <div style="background: #28a745; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2>✓ Ownership Transfer Approved</h2>
          </div>
          <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
            <p>Dear ${transfer.currentOwner.fullName},</p>
            <p>Your land ownership transfer has been <strong>APPROVED</strong> by the Governor.</p>
            <p><strong>Transfer Details:</strong></p>
            <ul>
              <li>Transfer ID: ${transferId}</li>
              <li>Land: ${transfer.land.address || `${transfer.land.latitude}, ${transfer.land.longitude}`}</li>
              <li>New Owner: ${newOwner?.fullName || transfer.newOwnerEmail}</li>
              <li>Approved Date: ${new Date().toLocaleDateString()}</li>
            </ul>
            ${governorComment ? `<p><strong>Governor's Comment:</strong> ${governorComment}</p>` : ""}
            <p>The land is now officially registered to the new owner.</p>
          </div>
        </div>
        `
      );
    }

    if (newOwner.email) {
      await sendEmail(
        newOwner.email,
        "Land Ownership Transfer - APPROVED - New Owner",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
          <div style="background: #28a745; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2>✓ Land Ownership Transferred to You</h2>
          </div>
          <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
            <p>Dear ${newOwner.fullName},</p>
            <p>Congratulations! The land ownership transfer has been <strong>APPROVED</strong>.</p>
            <p><strong>Your New Land:</strong></p>
            <ul>
              <li>Location: ${transfer.land.address || `${transfer.land.latitude}, ${transfer.land.longitude}`}</li>
              <li>Size: ${transfer.land.squareMeters}m²</li>
              <li>Transfer ID: ${transferId}</li>
            </ul>
            <p>You are now the official owner of this land. You can now apply for Certificate of Occupancy (CofO).</p>
          </div>
        </div>
        `
      );
    }

    res.status(200).json({
      message: "Ownership transfer approved successfully",
      transferId,
      newOwnerId: newOwner.id,
    });
  } catch (err) {
    console.error("Approval error:", err);
    res.status(500).json({ message: "Approval failed", error: String(err) });
  }
};

/* ===============================
   6. GOVERNOR REJECTS TRANSFER
================================ */

export const rejectOwnershipTransfer = async (
  req: AuthRequest,
  res: Response
) => {
  const governorId = req.user.id;
  const { transferId } = req.params;
  const { rejectionReason, governorComment } = req.body;

  try {
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
    });

    if (!governor || governor.role !== "GOVERNOR") {
      return res.status(403).json({ message: "Governor access required" });
    }

    if (!rejectionReason || rejectionReason.trim().length === 0) {
      return res.status(400).json({
        message: "Rejection reason is required",
      });
    }

    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: { include: { state: true } },
        currentOwner: true,
        documents: true,
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    if (transfer.land.state.governorId !== governorId) {
      return res.status(403).json({
        message: "You can only review transfers in your state",
      });
    }

    if (transfer.status !== "PENDING_GOVERNOR") {
      return res.status(400).json({
        message: `Transfer cannot be rejected in ${transfer.status} status`,
      });
    }

    // Update transfer in transaction
    await prisma.$transaction(async (tx) => {
      // Mark documents as rejected
      await tx.ownershipTransferDocument.updateMany({
        where: { transferId },
        data: {
          status: "REJECTED",
          rejectionMessage: rejectionReason,
        },
      });

      // Update transfer
      await tx.ownershipTransfer.update({
        where: { id: transferId },
        data: {
          status: "REJECTED",
          governorId,
          reviewedAt: new Date(),
          rejectionReason,
          governorComment,
        },
      });

      // Create audit log
      await tx.ownershipTransferAuditLog.create({
        data: {
          transferId,
          action: "REJECTED",
          performedById: governorId,
          performedByRole: "GOVERNOR",
          comment: `Rejection: ${rejectionReason}${governorComment ? ` | ${governorComment}` : ""}`,
        },
      });
    });

    // Send rejection email to current owner
    if (transfer.currentOwner?.email) {
      await sendEmail(
        transfer.currentOwner.email,
        "Land Ownership Transfer - REJECTED",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
          <div style="background: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2>✗ Ownership Transfer Rejected</h2>
          </div>
          <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
            <p>Dear ${transfer.currentOwner.fullName},</p>
            <p>Unfortunately, your land ownership transfer has been <strong>REJECTED</strong> by the Governor.</p>
            <p><strong>Rejection Reason:</strong></p>
            <p style="background: #f8d7da; padding: 10px; border-left: 4px solid #dc3545; margin: 15px 0;">
              ${rejectionReason}
            </p>
            ${governorComment ? `<p><strong>Additional Comment:</strong> ${governorComment}</p>` : ""}
            <p>Please review the rejection reason and resubmit your transfer with corrected documents or information.</p>
            <p><strong>Transfer ID:</strong> ${transferId}</p>
          </div>
        </div>
        `
      );
    }

    res.status(200).json({
      message: "Ownership transfer rejected successfully",
      transferId,
      rejectionReason,
    });
  } catch (err) {
    console.error("Rejection error:", err);
    res.status(500).json({ message: "Rejection failed", error: String(err) });
  }
};
/* ===============================
   8. LIST TRANSFERS FOR GOVERNOR
================================ */

export const listTransfersForGovernor = async (
  req: AuthRequest,
  res: Response
) => {
  const governorId = req.user.id;

  try {
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
    });

    if (!governor || governor.role !== "GOVERNOR") {
      return res.status(403).json({ message: "Governor access required" });
    }

    // Get all transfers pending governor review in this state
    const transfers = await prisma.ownershipTransfer.findMany({
      where: {
        land: {
          state: {
            governorId,
          },
        },
      },
      include: {
        land: {
          include: { state: true, owner: true },
        },
        documents: true,
        currentOwner: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by status
    const groupedByStatus = {
      pending: transfers.filter((t) => t.status === "PENDING_GOVERNOR"),
      approved: transfers.filter((t) => t.status === "APPROVED"),
      rejected: transfers.filter((t) => t.status === "REJECTED"),
      all: transfers,
    };

    res.json({
      summary: {
        total: transfers.length,
        pending: groupedByStatus.pending.length,
        approved: groupedByStatus.approved.length,
        rejected: groupedByStatus.rejected.length,
      },
      transfers: groupedByStatus,
    });
  } catch (err) {
    console.error("List transfers error:", err);
    res.status(500).json({ message: "Failed to retrieve transfers", error: String(err) });
  }
};
/* ===============================
   7. GET TRANSFER PROGRESS
================================ */

export const getTransferProgress = async (
  req: AuthRequest,
  res: Response
) => {
  const userId = req.user.sub;
  const { transferId } = req.params;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: { include: { state: true } },
        documents: true,
        verifications: {
          select: {
            target: true,
            channelType: true,
            isVerified: true,
          },
        },
        transferAuditLogs: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Check authorization: user must be current owner, new owner, or governor
    const currentOwner = await prisma.user.findUnique({
      where: { id: transfer.currentOwnerId },
    });

    const isAuthorized =
      transfer.currentOwnerId === userId ||
      transfer.newOwnerId === userId ||
      (transfer.governorId === userId);

    if (!isAuthorized && currentOwner?.email !== userId) {
      return res.status(403).json({
        message: "You are not authorized to view this transfer",
      });
    }

    // Calculate progress
    const verifiedCount = transfer.verifications.filter((v) => v.isVerified).length;
    const totalVerifications = transfer.verifications.length;
    const verificationProgress =
      totalVerifications > 0 ? Math.round((verifiedCount / totalVerifications) * 100) : 0;

    const documentsApprovedCount = transfer.documents.filter(
      (d) => d.status === "APPROVED"
    ).length;
    const documentsRejectedCount = transfer.documents.filter(
      (d) => d.status === "REJECTED"
    ).length;

    const progressStages = [
      {
        stage: "INITIATED",
        completed: true,
        completedAt: transfer.createdAt,
      },
      {
        stage: "VERIFICATION",
        completed: transfer.status !== "INITIATED",
        progress: verificationProgress,
        details: {
          verified: verifiedCount,
          total: totalVerifications,
          targets: transfer.verifications.map((v) => ({
            target: v.target,
            channelType: v.channelType,
            isVerified: v.isVerified,
          })),
        },
      },
      {
        stage: "DOCUMENTS_SUBMITTED",
        completed: ["PENDING_GOVERNOR", "APPROVED", "REJECTED"].includes(
          transfer.status
        ),
        submittedDocuments: transfer.documents.length,
      },
      {
        stage: "GOVERNOR_REVIEW",
        completed: ["APPROVED", "REJECTED"].includes(transfer.status),
        details: {
          approved: documentsApprovedCount,
          rejected: documentsRejectedCount,
          pending: transfer.documents.filter((d) => d.status === "PENDING").length,
        },
      },
      {
        stage: "COMPLETED",
        completed: transfer.status === "APPROVED",
        completedAt: transfer.reviewedAt,
      },
    ];

    res.json({
      transferId,
      currentStatus: transfer.status,
      progressPercentage: calculateProgressPercentage(transfer.status),
      stages: progressStages,
      landDetails: {
        id: transfer.land.id,
        address: transfer.land.address,
        size: transfer.land.squareMeters,
        state: transfer.land.state.name,
      },
      timestamps: {
        createdAt: transfer.createdAt,
        reviewedAt: transfer.reviewedAt,
        expiresAt: transfer.expiresAt,
      },
      recentActivity: transfer.transferAuditLogs.slice(0, 5).map((log) => ({
        action: log.action,
        date: log.createdAt,
        comment: log.comment,
      })),
    });
  } catch (err) {
    console.error("Progress fetch error:", err);
    res.status(500).json({ message: "Failed to retrieve progress", error: String(err) });
  }
};



/* ===============================
   HELPER FUNCTION
================================ */

function calculateProgressPercentage(status: string): number {
  const statusMap: Record<string, number> = {
    INITIATED: 10,
    VERIFIED_BY_PARTIES: 40,
    PENDING_GOVERNOR: 70,
    APPROVED: 100,
    REJECTED: 0,
    EXPIRED: 0,
  };
  return statusMap[status] || 0;
}
/* ===============================
   9. GET USER OWNERSHIP TRANSFERS
================================ */

export const getUserOwnershipTransfers = async (
  req: AuthRequest,
  res: Response
) => {
  const userId = req.user.sub;

  try {
    // Get all transfers where user is current owner or new owner
    const transfers = await prisma.ownershipTransfer.findMany({
      where: {
        OR: [
          { currentOwnerId: userId },
          { newOwnerId: userId },
        ],
      },
      include: {
        land: {
          include: { state: true, owner: true },
        },
        documents: true,
        currentOwner: true,
        verifications: {
          select: {
            target: true,
            channelType: true,
            isVerified: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Transform and group by status
    const groupedByStatus = {
      initiated: transfers.filter((t) => t.status === "INITIATED"),
      verifiedByParties: transfers.filter((t) => t.status === "VERIFIED_BY_PARTIES"),
      pendingGovernor: transfers.filter((t) => t.status === "PENDING_GOVERNOR"),
      approved: transfers.filter((t) => t.status === "APPROVED"),
      rejected: transfers.filter((t) => t.status === "REJECTED"),
      expired: transfers.filter((t) => t.status === "EXPIRED"),
      all: transfers,
    };

    // Map transfers with additional data
    const mappedTransfers = transfers.map((transfer) => {
      const verifiedCount = transfer.verifications.filter(
        (v) => v.isVerified
      ).length;
      const totalVerifications = transfer.verifications.length;

      return {
        id: transfer.id,
        landId: transfer.landId,
        status: transfer.status,
        createdAt: transfer.createdAt,
        reviewedAt: transfer.reviewedAt,
        expiresAt: transfer.expiresAt,
        userRole: transfer.currentOwnerId === userId ? "CURRENT_OWNER" : "NEW_OWNER",
        land: {
          id: transfer.land.id,
          address: transfer.land.address,
          size: transfer.land.squareMeters,
          state: transfer.land.state.name,
          currentOwner: transfer.land.owner.fullName,
        },
        documentation: {
          submitted: transfer.documents.length,
          approved: transfer.documents.filter((d) => d.status === "APPROVED").length,
          rejected: transfer.documents.filter((d) => d.status === "REJECTED").length,
          pending: transfer.documents.filter((d) => d.status === "PENDING").length,
        },
        verification: {
          verified: verifiedCount,
          total: totalVerifications,
          progress:
            totalVerifications > 0
              ? Math.round((verifiedCount / totalVerifications) * 100)
              : 0,
        },
        progressPercentage: calculateProgressPercentage(transfer.status),
        targets: transfer.verifications.map((v) => ({
          target: v.target,
          channelType: v.channelType,
          isVerified: v.isVerified,
        })),
      };
    });

    res.json({
      summary: {
        total: transfers.length,
        initiated: groupedByStatus.initiated.length,
        verifiedByParties: groupedByStatus.verifiedByParties.length,
        pendingGovernor: groupedByStatus.pendingGovernor.length,
        approved: groupedByStatus.approved.length,
        rejected: groupedByStatus.rejected.length,
        expired: groupedByStatus.expired.length,
      },
      transfers: mappedTransfers,
    });
  } catch (err) {
    console.error("Get user transfers error:", err);
    res.status(500).json({
      message: "Failed to retrieve user transfers",
      error: String(err),
    });
  }
};
export const resendTransferOTP = async (req: AuthRequest, res: Response) => {
  const ownerId = req.user.sub;
  const { transferId, target } = req.body;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { verifications: true },
    });

    if (!transfer || transfer.currentOwnerId !== ownerId)
      return res.status(403).json({ message: "Unauthorized" });

    if (transfer.status !== "INITIATED")
      return res.status(400).json({ message: "OTP phase completed already" });

    const record = transfer.verifications.find(v => v.target === target);

    if (!record)
      return res.status(404).json({ message: "Channel not found" });

    // ⛔ Cooldown protection (60 seconds)
    const cooldown = 60 * 1000;
    if (Date.now() - record.createdAt.getTime() < cooldown) {
      return res.status(429).json({
        message: "Please wait before requesting another code",
      });
    }

    const newCode = crypto.randomInt(100000, 999999).toString();
    const newExpiry = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.transferVerification.update({
      where: { id: record.id },
      data: {
        code: newCode,
        expiresAt: newExpiry,
        isVerified: false,
      },
    });

    if (record.channelType === "email") {
      await sendEmail(
        record.target,
        "Land Ownership Transfer — Verification Code",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 8px;">
          <div style="background: #004CFF; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <h2>Land Ownership Transfer — Verification Code</h2>
          </div>
          <div style="padding: 20px;">
            <p>Dear Recipient,</p>
            <p>
              This message concerns a pending request to transfer ownership of a parcel of land recorded in our system. To validate and proceed with the transfer associated with <strong>Transfer ID: ${transfer.id}</strong>, please use the One‑Time Passcode (OTP) shown below.
            </p>
            <div style="background: #f5f5f5; padding: 15px; text-align: center; border-radius: 5px; margin: 20px 0;">
              <p style="font-size: 24px; font-weight: bold; color: #004CFF; margin: 0;">${newCode}</p>
            </div>
            <p><strong>Expiry:</strong> This code will expire in 15 minutes from issuance.</p>
            <p><strong>Important Instructions</strong></p>
            <ol>
              <li>Enter the OTP in the GeoTech portal where requested to confirm your identity and continue the transfer process.</li>
              <li>Do not share this code with anyone. GeoTech will never request your OTP by phone or in a follow-up email.</li>
              <li>If you did not authorize or expect this transfer, please disregard this message and contact our support team immediately.</li>
            </ol>
            <p style="color: #666; font-size: 12px; margin-top: 20px;">
              For assistance, contact our support team at <strong>support@geotech.example</strong> or reply to this message. This is an automated notification from the GeoTech system.
            </p>
          </div>
        </div>
        `
      );
    } else {
      console.log(`SMS ${record.target}: ${newCode}`);
    }

    res.json({ message: "New OTP sent successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to resend OTP", err });
  }
};

/* ===============================
   10. APPROVE INDIVIDUAL DOCUMENT
================================ */

export const approveDocument = async (req: AuthRequest, res: Response) => {
  const governorId = req.user.id;
  const { documentId } = req.params;

  try {
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
    });

    if (!governor || governor.role !== "GOVERNOR") {
      return res.status(403).json({ message: "Governor access required" });
    }

    // Find document and verify governor can approve it
    const document = await prisma.ownershipTransferDocument.findUnique({
      where: { id: documentId },
      include: {
        transfer: {
          include: { land: { include: { state: true } } },
        },
      },
    });

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Ensure governor is reviewing transfers in their state
    if (document.transfer.land.state.governorId !== governorId) {
      return res.status(403).json({
        message: "You can only review documents in your state",
      });
    }

    if (document.status !== "PENDING") {
      return res.status(400).json({
        message: `Document is already ${document.status.toLowerCase()}`,
      });
    }

    // Approve document
    await prisma.ownershipTransferDocument.update({
      where: { id: documentId },
      data: {
        status: "APPROVED",
        rejectionMessage: null, // Clear any previous rejection message
      },
    });

    // Create audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId: document.transferId,
        action: "DOCUMENT_APPROVED",
        performedById: governorId,
        performedByRole: "GOVERNOR",
        comment: `Document approved: ${document.title}`,
      },
    });

    res.json({
      message: "Document approved successfully",
      documentId,
      status: "APPROVED",
    });
  } catch (err) {
    console.error("Document approval error:", err);
    res.status(500).json({ message: "Failed to approve document", error: String(err) });
  }
};

/* ===============================
   11. REJECT INDIVIDUAL DOCUMENT
================================ */

export const rejectDocument = async (req: AuthRequest, res: Response) => {
  const governorId = req.user.id;
  const { documentId } = req.params;
  const { rejectionMessage } = req.body;

  try {
    if (!rejectionMessage || rejectionMessage.trim().length === 0) {
      return res.status(400).json({
        message: "Rejection message is required",
      });
    }

    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
    });

    if (!governor || governor.role !== "GOVERNOR") {
      return res.status(403).json({ message: "Governor access required" });
    }

    // Find document and verify governor can reject it
    const document = await prisma.ownershipTransferDocument.findUnique({
      where: { id: documentId },
      include: {
        transfer: {
          include: { 
            land: { include: { state: true, owner: true } },
            currentOwner: true,
          },
        },
      },
    });

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Ensure governor is reviewing transfers in their state
    if (document.transfer.land.state.governorId !== governorId) {
      return res.status(403).json({
        message: "You can only review documents in your state",
      });
    }

    if (document.status !== "PENDING") {
      return res.status(400).json({
        message: `Document is already ${document.status.toLowerCase()}`,
      });
    }

    // Reject document with message
    await prisma.ownershipTransferDocument.update({
      where: { id: documentId },
      data: {
        status: "REJECTED",
        rejectionMessage,
      },
    });

    // Create audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId: document.transferId,
        action: "DOCUMENT_REJECTED",
        performedById: governorId,
        performedByRole: "GOVERNOR",
        comment: `Document rejected: ${document.title} - ${rejectionMessage}`,
      },
    });

    // Notify current owner about rejected document
    if (document.transfer.currentOwner?.email) {
      await sendEmail(
        document.transfer.currentOwner.email,
        "Document Rejected - Resubmission Required",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 8px;">
          <div style="background: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2>Document Requires Correction</h2>
          </div>
          <div style="padding: 20px;">
            <p>Dear ${document.transfer.currentOwner.fullName},</p>
            <p>One of your submitted documents has been rejected and requires resubmission.</p>
            <p><strong>Document:</strong> ${document.title}</p>
            <p><strong>Reason for Rejection:</strong></p>
            <p style="background: #f8d7da; padding: 10px; border-left: 4px solid #dc3545; margin: 15px 0;">
              ${rejectionMessage}
            </p>
            <p><strong>Transfer ID:</strong> ${document.transferId}</p>
            <p>Please correct the document according to the rejection reason and resubmit it through your GeoTech dashboard.</p>
            <p style="color: #666; font-size: 12px; margin-top: 20px;">
              For assistance, contact our support team.
            </p>
          </div>
        </div>
        `
      );
    }

    res.json({
      message: "Document rejected successfully",
      documentId,
      status: "REJECTED",
      rejectionMessage,
    });
  } catch (err) {
    console.error("Document rejection error:", err);
    res.status(500).json({ message: "Failed to reject document", error: String(err) });
  }
};
