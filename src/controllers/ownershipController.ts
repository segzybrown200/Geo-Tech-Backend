import prisma from "../lib/prisma";
import crypto from "crypto";
import { Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";
import { sendEmail } from "../services/emailSevices";
import { uploadToCloudinary, validateDocumentFile } from "../services/uploadService";
import {
  ownershipTransferInitiateSchema,
  ownershipTransferVerifySchema,
  ownershipTransferReviewSchema,
} from "../utils/zodSchemas";
import {
  convertUTMToLatLng,
  bearingsToCoordinates,
  calculateAreaFromUTM,
  isClosed,
} from "../utils/germetry";

function toWKTPolygon(coords: number[][]) {
  const formatted = coords
    .map(([lat, lng]) => `${lng} ${lat}`)
    .join(",");
  return `POLYGON((${formatted}))`;
}

function closePolygon(coords: number[][]) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...coords, first];
  }
  return coords;
}

function normalizeLatLngOrder(coords: number[][]): number[][] {
  const looksLikeLngLat = coords.some(
    ([lat, lng]) => Math.abs(lat) > 90 && Math.abs(lng) <= 90,
  );
  if (looksLikeLngLat) return coords.map(([lat, lng]) => [lng, lat]);
  return coords;
}

/* ===============================
   1. INITIATE OWNERSHIP TRANSFER
================================ */

export const initiateOwnershipTransfer = async (
  req: AuthRequest,
  res: Response
) => {
  const body = ownershipTransferInitiateSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid transfer input",
      errors: body.error.flatten(),
    });
  }

  const {
    landId,
    newOwnerEmail,
    newOwnerPhone,
    transferType,
    transferSurveyType,
    coordinates,
    bearings,
    startPoint,
    utmZone,
    measuredAreaSqm,
  } = body.data;

  const ownerId = req.user.sub;

  try {
    // Validate land ownership
    const land = await prisma.landRegistration.findUnique({
      where: { id: landId },
      include: { owner: true, state: true },
    });

    if (!land || land.ownerId !== ownerId) {
      return res.status(403).json({ message: "You don't own this land" });
    }

    if (land.landStatus !== "APPROVED") {
      return res.status(400).json({ message: "Land must be approved to transfer" });
    }

    // For partial transfers, validate boundary
    let transferBoundary: any = null;
    let transferUTM: number[][] = [];
    let transferLatLng: number[][] = [];
    let finalTransferArea = 0;

    if (transferType === "PARTIAL") {
      if (!transferSurveyType) {
        return res.status(400).json({ message: "Survey type required for partial transfer" });
      }

      if (transferSurveyType === "COORDINATE") {
        if (!coordinates || coordinates.length < 4) {
          return res.status(400).json({ message: "At least 4 coordinates required" });
        }
        const normalized = normalizeLatLngOrder(coordinates);
        transferLatLng = closePolygon(normalized);
        if (!utmZone) {
          return res.status(400).json({ message: "UTM zone required" });
        }
        transferUTM = transferLatLng.map(([lat, lng]) =>
          convertUTMToLatLng(lat, lng, utmZone, true)
        );
      } else if (transferSurveyType === "BEARING") {
        if (!bearings || bearings.length < 3 || !startPoint || !utmZone) {
          return res.status(400).json({ message: "Bearings, start point, and UTM zone required" });
        }
        const result = bearingsToCoordinates(bearings, utmZone, startPoint, true);
        transferLatLng = closePolygon(result.latlngCoordinates);
        transferUTM = closePolygon(result.utmCoordinates);
        if (!isClosed(transferUTM)) {
          return res.status(400).json({ message: "Transfer polygon not closed" });
        }
      }

      // Validate transfer boundary is within original land
      const transferWKT = toWKTPolygon(transferLatLng);
      const withinCheck = await prisma.$queryRaw<{ within: boolean }[]>`
        SELECT ST_Within(ST_GeomFromText(${transferWKT}, 4326), boundary) as within
        FROM "LandRegistration" WHERE id = ${landId}
      `;
      if (!withinCheck[0]?.within) {
        return res.status(400).json({ message: "Transfer boundary must be within original land" });
      }

      finalTransferArea = calculateAreaFromUTM(transferUTM);
      if (measuredAreaSqm) {
        const diff = Math.abs(finalTransferArea - measuredAreaSqm);
        if (diff > 10) {
          return res.status(400).json({
            message: `Area mismatch: calculated ${finalTransferArea.toFixed(2)}m², measured ${measuredAreaSqm.toFixed(2)}m²`,
          });
        }
      }

      transferBoundary = {
        transferSurveyType,
        transferCoordinates: transferLatLng,
        transferBearings: bearings,
        transferUtmZone: utmZone,
        transferAreaSqm: finalTransferArea,
        transferCenterLat: transferLatLng.reduce((sum, [lat]) => sum + lat, 0) / transferLatLng.length,
        transferCenterLng: transferLatLng.reduce((sum, [, lng]) => sum + lng, 0) / transferLatLng.length,
      };
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Create transfer record
    const transfer = await prisma.ownershipTransfer.create({
      data: {
        landId,
        currentOwnerId: ownerId,
        newOwnerEmail,
        newOwnerPhone,
        transferType,
        ...transferBoundary,
        expiresAt,
        applicationNumber: `OT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      },
    });

    // Create verification channels
    const channels = [];
    if (newOwnerEmail) channels.push({ type: "email", value: newOwnerEmail });
    if (newOwnerPhone) channels.push({ type: "phone", value: newOwnerPhone });

    const verificationRecords = [];
    const verificationCodes: Record<string, string> = {};

    for (const channel of channels) {
      const code = crypto.randomInt(100000, 999999).toString();
      verificationCodes[channel.value] = code;
      verificationRecords.push({
        transferId: transfer.id,
        channelType: channel.type,
        target: channel.value,
        code,
        expiresAt,
      });

      // Send verification
      if (channel.type === "email") {
        await sendEmail(
          channel.value,
          "Land Ownership Transfer - Verification",
          `<p>Your verification code: <strong>${code}</strong></p>`
        );
      }
    }

    await prisma.transferVerification.createMany({ data: verificationRecords });

    // Audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId: transfer.id,
        action: "INITIATED",
        performedById: ownerId,
        performedByRole: "USER",
        comment: `${transferType} transfer initiated`,
      },
    });

    res.status(201).json({
      message: "Transfer initiated",
      transferId: transfer.id,
      transferType,
      expiresAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Transfer initiation failed" });
  }
};

/* ===============================
   2. VERIFY TRANSFER
================================ */

export const verifyTransfer = async (req: AuthRequest, res: Response) => {
  const body = ownershipTransferVerifySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid input",
      errors: body.error.flatten(),
    });
  }

  const { transferId, code } = body.data;
  const userId = req.user.sub;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { verifications: true },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Find verification record
    const verification = transfer.verifications.find(v => v.code === code);
    if (!verification || verification.isVerified) {
      return res.status(400).json({ message: "Invalid or used code" });
    }

    if (new Date() > verification.expiresAt) {
      return res.status(400).json({ message: "Code expired" });
    }

    await prisma.transferVerification.update({
      where: { id: verification.id },
      data: { isVerified: true },
    });

    // Check if all verified
    const unverified = transfer.verifications.filter(v => !v.isVerified);
    if (unverified.length === 0) {
      // Start approval workflow
      await startApprovalWorkflow(transferId);
    }

    res.json({ message: "Verified successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification failed" });
  }
};

/* ===============================
   3. START APPROVAL WORKFLOW
================================ */

async function startApprovalWorkflow(transferId: string) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: { land: { include: { state: true } } },
  });

  if (!transfer) return;

  // Find first approver (lowest position in state)
  const firstApprover = await prisma.internalUser.findFirst({
    where: {
      stateId: transfer.land.stateId,
      role: "APPROVER",
    },
    orderBy: { position: "asc" },
  });

  if (firstApprover) {
    await prisma.ownershipTransfer.update({
      where: { id: transferId },
      data: {
        status: "PENDING_GOVERNOR", // Will be updated as it progresses
        currentReviewerId: firstApprover.id,
      },
    });

    await prisma.transferStageLog.create({
      data: {
        transferId,
        stageNumber: 1,
        internalUserId: firstApprover.id,
        status: "PENDING",
        arrivedAt: new Date(),
      },
    });

    // Notify approver
    if (firstApprover.email) {
      await sendEmail(
        firstApprover.email,
        "New Ownership Transfer for Review",
        `<p>Please review transfer ${transferId}</p>`
      );
    }
  }
}

/* ===============================
   4. REVIEW TRANSFER
================================ */

export const reviewTransfer = async (req: AuthRequest, res: Response) => {
  const body = ownershipTransferReviewSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid input",
      errors: body.error.flatten(),
    });
  }

  const { transferId, action, message, signatureUrl } = body.data;
  const reviewerId = req.user.id;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: true,
        currentReviewer: true,
        stages: { orderBy: { stageNumber: "desc" } },
      },
    });

    if (!transfer || transfer.currentReviewerId !== reviewerId) {
      return res.status(403).json({ message: "Not authorized to review this transfer" });
    }

    const currentStage = transfer.stages[0];
    if (!currentStage) {
      return res.status(400).json({ message: "No active stage" });
    }

    if (action === "APPROVE") {
      // Check if governor
      if (transfer.currentReviewer?.role === "GOVERNOR") {
        // Final approval
        await finalizeTransfer(transferId, reviewerId, message, signatureUrl);
      } else {
        // Forward to next approver or governor
        await forwardToNextReviewer(transferId, reviewerId, message);
      }
    } else if (action === "REJECT") {
      await rejectTransfer(transferId, reviewerId, message);
    }

    res.json({ message: "Review submitted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Review failed" });
  }
};

/* ===============================
   5. FINALIZE TRANSFER
================================ */

async function finalizeTransfer(
  transferId: string,
  governorId: string,
  comment?: string,
  signatureUrl?: string
) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: { land: true },
  });

  if (!transfer) return;

  await prisma.$transaction(async (tx) => {
    if (transfer.transferType === "FULL") {
      // Update land owner
      await tx.landRegistration.update({
        where: { id: transfer.landId },
        data: { ownerId: transfer.newOwnerId! },
      });
    } else {
      // Get original boundary as WKT
      const originalBoundary = await tx.$queryRaw<{ boundary: string }[]>`
        SELECT ST_AsText(boundary) as boundary FROM "LandRegistration" WHERE id = ${transfer.landId}
      `;
      const originalWKT = originalBoundary[0]?.boundary;

      // Create new land for transferred portion
      const transferWKT = toWKTPolygon(transfer.transferCoordinates as number[][]);
      const newLandId = crypto.randomUUID();
      await tx.$queryRaw`
        INSERT INTO "LandRegistration" (
          id, landCode, ownerId, ownerName, ownershipType, purpose, titleType,
          stateId, address, areaSqm, centerLat, centerLng, surveyType, utmZone,
          utmCoordinates, latlngCoordinates, boundary, landStatus, isVerified, createdAt
        ) VALUES (
          ${newLandId},
          ${`SUB-${transfer.land.landCode}-${Date.now()}`},
          ${transfer.newOwnerId},
          ${transfer.newOwnerEmail},
          ${transfer.land.ownershipType},
          ${transfer.land.purpose},
          ${transfer.land.titleType},
          ${transfer.land.stateId},
          ${transfer.land.address},
          ${transfer.transferAreaSqm},
          ${transfer.transferCenterLat},
          ${transfer.transferCenterLng},
          ${transfer.transferSurveyType},
          ${transfer.transferUtmZone},
          ${transfer.transferCoordinates ? JSON.stringify(transfer.transferCoordinates) : null},
          ${transfer.transferCoordinates ? JSON.stringify(transfer.transferCoordinates) : null},
          ST_GeomFromText(${transferWKT}, 4326),
          'APPROVED',
          true,
          now()
        )
      `;

      // Update original land boundary (subtract transferred area)
      await tx.$queryRaw`
        UPDATE "LandRegistration"
        SET boundary = ST_Difference(boundary, ST_GeomFromText(${transferWKT}, 4326)),
            areaSqm = areaSqm - ${transfer.transferAreaSqm}
        WHERE id = ${transfer.landId}
      `;

      // Link transferred land
      await tx.ownershipTransfer.update({
        where: { id: transferId },
        data: { transferredLandId: newLandId },
      });
    }

    // Update transfer status
    await tx.ownershipTransfer.update({
      where: { id: transferId },
      data: {
        status: "APPROVED",
        governorId,
        reviewedAt: new Date(),
        governorComment: comment,
      },
    });

    // Audit log
    await tx.ownershipTransferAuditLog.create({
      data: {
        transferId,
        action: "APPROVED",
        performedById: governorId,
        performedByRole: "GOVERNOR",
        comment,
      },
    });
  });
}

/* ===============================
   6. FORWARD TO NEXT REVIEWER
================================ */

async function forwardToNextReviewer(
  transferId: string,
  currentReviewerId: string,
  comment?: string
) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: { land: { include: { state: true } }, stages: true },
  });

  if (!transfer) return;

  const currentStage = transfer.stages[transfer.stages.length - 1];
  const nextPosition = (currentStage?.stageNumber || 0) + 1;

  // Find next approver
  const nextApprover = await prisma.internalUser.findFirst({
    where: {
      stateId: transfer.land.stateId,
      role: "APPROVER",
      position: { gt: nextPosition - 1 }, // Next position
    },
    orderBy: { position: "asc" },
  });

  if (nextApprover) {
    // Forward to next approver
    await prisma.ownershipTransfer.update({
      where: { id: transferId },
      data: { currentReviewerId: nextApprover.id },
    });

    await prisma.transferStageLog.create({
      data: {
        transferId,
        stageNumber: nextPosition,
        internalUserId: nextApprover.id,
        status: "PENDING",
        arrivedAt: new Date(),
      },
    });

    // Update previous stage
    await prisma.transferStageLog.update({
      where: { id: currentStage.id },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        message: comment,
      },
    });
  } else {
    // No more approvers, forward to governor
    const governor = await prisma.internalUser.findFirst({
      where: {
        stateId: transfer.land.stateId,
        role: "GOVERNOR",
      },
    });

    if (governor) {
      await prisma.ownershipTransfer.update({
        where: { id: transferId },
        data: { currentReviewerId: governor.id },
      });

      await prisma.transferStageLog.create({
        data: {
          transferId,
          stageNumber: nextPosition,
          internalUserId: governor.id,
          status: "PENDING",
          arrivedAt: new Date(),
        },
      });
    }
  }
}

/* ===============================
   7. REJECT TRANSFER
================================ */

async function rejectTransfer(
  transferId: string,
  reviewerId: string,
  reason?: string
) {
  await prisma.ownershipTransfer.update({
    where: { id: transferId },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
    },
  });

  await prisma.ownershipTransferAuditLog.create({
    data: {
      transferId,
      action: "REJECTED",
      performedById: reviewerId,
      performedByRole: "APPROVER",
      comment: reason,
    },
  });
}

/* ===============================
   8. GET TRANSFERS FOR REVIEW
================================ */

export const getTransfersForReview = async (req: AuthRequest, res: Response) => {
  const reviewerId = req.user.id;

  try {
    const transfers = await prisma.ownershipTransfer.findMany({
      where: { currentReviewerId: reviewerId },
      include: {
        land: { include: { state: true } },
        currentOwner: true,
        documents: true,
      },
    });

    res.json({ transfers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfers" });
  }
};

/* ===============================
   9. GET USER TRANSFERS
================================ */

export const getUserTransfers = async (req: AuthRequest, res: Response) => {
  const userId = req.user.sub;

  try {
    const transfers = await prisma.ownershipTransfer.findMany({
      where: {
        OR: [
          { currentOwnerId: userId },
          { newOwnerId: userId },
        ],
      },
      include: {
        land: true,
        documents: true,
        stages: { include: { approver: true } },
      },
    });

    res.json({ transfers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfers" });
  }
};

/* ===============================
   10. GET SINGLE TRANSFER FOR REVIEW
================================ */

export const getTransferForReview = async (req: AuthRequest, res: Response) => {
  const { transferId } = req.params;
  const reviewerId = req.user.id;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId, currentReviewerId: reviewerId },
      include: {
        land: { include: { state: true } },
        currentOwner: true,
        newOwner: true,
        documents: true,
        stages: { include: { approver: true }, orderBy: { stageNumber: "desc" } },
        verifications: true,
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found or not assigned to you" });
    }

    res.json({ transfer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfer" });
  }
};

    // Ensure governor can only review transfers in their state
//     if (transfer.land.state.governorId !== governorId) {
//       return res.status(403).json({
//         message: "You can only review transfers in your state",
//       });
//     }

//     res.json({ transfer });
//   } catch (err) {
//     console.error("Review fetch error:", err);
//     res.status(500).json({ message: "Failed to retrieve transfer", error: String(err) });
//   }
// };

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
              <li>Land: ${transfer.land.address || "Not specified"}</li>
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
              <li>Location: ${transfer.land.address || "Not specified"}</li>
              <li>Size: ${transfer.land.areaSqm ? `${transfer.land.areaSqm}m²` : "Not specified"}</li>
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
        size: transfer.land.areaSqm,
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
          size: transfer.land.areaSqm,
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
    res.status(500).json({ message: "Failed to reject document", error: String(err) });
  }
};
