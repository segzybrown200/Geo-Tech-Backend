import prisma from "../lib/prisma";
import crypto from "crypto";
import { Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";
import { sendEmail } from "../services/emailSevices";
import {
  uploadToCloudinary,
  validateDocumentFile,
} from "../services/uploadService";
import {
  ownershipTransferInitiateSchema,
  ownershipTransferVerifySchema,
  ownershipTransferReviewSchema,
  ownershipTransferDocumentUploadSchema,
} from "../utils/zodSchemas";
import {
  convertUTMToLatLng,
  bearingsToCoordinates,
  calculateAreaFromUTM,
  isClosed,
} from "../utils/germetry";
import { re } from "mathjs";

function toWKTPolygon(coords: number[][]) {
  const formatted = coords.map(([lat, lng]) => `${lng} ${lat}`).join(",");
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
  res: Response,
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

    // check if the newOwnerEmail is same as current owner's email
    if (newOwnerEmail && land?.owner?.email === newOwnerEmail) {
      return res.status(400).json({
        message:
          "New owner's email cannot be the same as current owner's email",
      });
    }
    // check if the newOwnerPhone is same as current owner's phone
    if (newOwnerPhone && land?.owner?.phone === newOwnerPhone) {
      return res.status(400).json({
        message:
          "New owner's phone cannot be the same as current owner's phone",
      });
    }
    // check if the newOwnerEmail is in the database as a user
    const existingUser = await prisma.user.findUnique({
      where: { email: newOwnerEmail },
    });

    if (!existingUser) {
      return res
        .status(400)
        .json({ message: "No user found with the provided new owner's email" });
    }

    if (!land || land.ownerId !== ownerId) {
      return res.status(403).json({ message: "You don't own this land" });
    }

    if (land.landStatus !== "APPROVED") {
      return res
        .status(400)
        .json({ message: "Land must be approved to transfer" });
    }

    // For partial transfers, validate boundary
    let transferBoundary: any = null;
    let transferUTM: number[][] = [];
    let transferLatLng: number[][] = [];
    let finalTransferArea = 0;

    if (transferType === "PARTIAL") {
      if (!transferSurveyType) {
        return res
          .status(400)
          .json({ message: "Survey type required for partial transfer" });
      }

      if (transferSurveyType === "COORDINATE") {
        if (!coordinates || coordinates.length < 4) {
          return res
            .status(400)
            .json({ message: "At least 4 coordinates required" });
        }
        const normalized = normalizeLatLngOrder(coordinates);
        transferLatLng = closePolygon(normalized);
        if (!utmZone) {
          return res.status(400).json({ message: "UTM zone required" });
        }
        transferUTM = transferLatLng.map(([lat, lng]) =>
          convertUTMToLatLng(lat, lng, utmZone, true),
        );
      } else if (transferSurveyType === "BEARING") {
        if (!bearings || bearings.length < 3 || !startPoint || !utmZone) {
          return res
            .status(400)
            .json({ message: "Bearings, start point, and UTM zone required" });
        }
        const result = bearingsToCoordinates(
          bearings,
          utmZone,
          startPoint,
          true,
        );
        transferLatLng = closePolygon(result.latlngCoordinates);
        transferUTM = closePolygon(result.utmCoordinates);
        if (!isClosed(transferUTM)) {
          return res
            .status(400)
            .json({ message: "Transfer polygon not closed" });
        }
      }

      // Validate transfer boundary is within original land
      const transferWKT = toWKTPolygon(transferLatLng);
      // const withinCheck = await prisma.$queryRaw<{ within: boolean }[]>`
      //   SELECT ST_Within(ST_GeomFromText(${transferWKT}, 4326), boundary) as within
      //   FROM "LandRegistration" WHERE id = ${landId}
      // `;
      const withinCheck = await prisma.$queryRaw<{ within: boolean }[]>`
        SELECT ST_CoveredBy(
          ST_Buffer(ST_GeomFromText(${transferWKT}, 4326), -0.0000001),
          ST_Buffer(boundary, 0.0000001)
        ) as within
        FROM "LandRegistration"
        WHERE id = ${landId}
      `;
      if (!withinCheck[0]?.within) {
        return res
          .status(400)
          .json({ message: "Transfer boundary must be within original land" });
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
        transferCenterLat:
          transferLatLng.reduce((sum, [lat]) => sum + lat, 0) /
          transferLatLng.length,
        transferCenterLng:
          transferLatLng.reduce((sum, [, lng]) => sum + lng, 0) /
          transferLatLng.length,
        transferStartPoint: startPoint,
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
        newOwnerId: existingUser?.id || null, // Will be set after verification
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
          `<p>Your verification code: <strong>${code}</strong></p>`,
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
    const verification = transfer.verifications.find((v) => v.code === code);
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

    // Fetch updated verifications to check if all are now verified
    const updatedTransfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { verifications: true },
    });

    if (updatedTransfer) {
      const unverified = updatedTransfer.verifications.filter(
        (v) => !v.isVerified,
      );
      if (unverified.length === 0) {
        // Mark as verified by parties - documents needed next
        await prisma.ownershipTransfer.update({
          where: { id: transferId },
          data: { status: "VERIFIED_BY_PARTIES" },
        });
      }
    }

    res.json({
      message: "Verified successfully",
      allVerified: updatedTransfer?.verifications.every((v) => v.isVerified),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification failed" });
  }
};

/* ===============================
   3. START APPROVAL WORKFLOW
================================ */

/* ===============================
   3. START APPROVAL WORKFLOW
================================ */

async function startApprovalWorkflow(transferId: string) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: {
      land: { include: { state: true } },
      currentOwner: true,
      documents: true,
    },
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
        stageNumber: firstApprover.position || 1,
        internalUserId: firstApprover.id,
        status: "PENDING",
        arrivedAt: new Date(),
      },
    });

    // Send detailed notification email to approver
    await sendApproverNotification(
      firstApprover,
      transfer,
      "New Transfer Assigned for Review",
    );
  }
}

/* ===============================
   3.5. SEND APPROVER NOTIFICATION
================================ */

async function sendApproverNotification(
  approver: any,
  transfer: any,
  subject: string,
) {
  if (!approver.email) return;

  const transferType =
    transfer.transferType === "FULL" ? "Full Ownership" : "Partial Ownership";
  const documentCount = transfer.documents?.length || 0;

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
      <div style="background: #007bff; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2>📋 ${subject}</h2>
      </div>
      <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
        <p>Dear ${approver.name},</p>
        <p>A new ownership transfer has been assigned to you for review.</p>

        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
          <h3 style="margin-top: 0; color: #333;">Transfer Details:</h3>
          <ul style="list-style: none; padding: 0;">
            <li><strong>Transfer ID:</strong> ${transfer.id}</li>
            <li><strong>Application #:</strong> ${transfer.applicationNumber}</li>
            <li><strong>Type:</strong> ${transferType}</li>
            <li><strong>Land Code:</strong> ${transfer.land.landCode}</li>
            <li><strong>Location:</strong> ${transfer.land.address || "Not specified"}</li>
            <li><strong>Area:</strong> ${transfer.land.areaSqm ? `${transfer.land.areaSqm}m²` : "Not specified"}</li>
            <li><strong>Current Owner:</strong> ${transfer.currentOwner?.fullName || "Unknown"}</li>
            <li><strong>Documents:</strong> ${documentCount} uploaded</li>
          </ul>
        </div>

        <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 15px 0;">
          <p style="margin: 0;"><strong>⚡ Action Required:</strong> Please review this transfer in your dashboard.</p>
        </div>

        <div style="text-align: center; margin: 20px 0;">
          <a href="${process.env.FRONTEND_URL || "https://geo-tech-reviewer.vercel.app/"}/dashboard/transfers"
             style="background: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Review Transfer
          </a>
        </div>

        <p style="color: #666; font-size: 14px;">
          This is an automated notification. Please do not reply to this email.
        </p>
      </div>
    </div>
  `;

  await sendEmail(approver.email, subject, emailHtml);
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

  const { transferId, action, message } = body.data;
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
      return res
        .status(403)
        .json({ message: "Not authorized to review this transfer" });
    }

    const currentStage = transfer.stages[0];
    if (!currentStage) {
      return res.status(400).json({ message: "No active stage" });
    }

    if (action === "APPROVE") {
      // Check if all documents have been reviewed by current reviewer
      const documents = await prisma.ownershipTransferDocument.findMany({
        where: { transferId },
        include: {
          reviews: {
            where: { reviewerId },
          },
        },
      });

      const unreviewedDocuments = documents.filter(
        (doc) => doc.reviews.length === 0,
      );
      if (unreviewedDocuments.length > 0) {
        return res.status(400).json({
          message:
            "All documents must be reviewed before approving the transfer",
          unreviewedDocuments: unreviewedDocuments.map((doc) => ({
            id: doc.id,
            title: doc.title,
          })),
        });
      }

      // Check if governor
      if (transfer.currentReviewer?.role === "GOVERNOR") {
        // Final approval
        await finalizeTransfer(transferId, reviewerId, message);
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

// async function finalizeTransfer(
//   transferId: string,
//   governorId: string,
//   comment?: string,
// ) {
//   const transfer = await prisma.ownershipTransfer.findUnique({
//     where: { id: transferId },
//     include: { land: true },
//   });

//   if (!transfer) return;

//   await prisma.$transaction(async (tx) => {
//     if (transfer.transferType === "FULL") {
//       // Update land owner
//       await tx.landRegistration.update({
//         where: { id: transfer.landId },
//         data: { ownerId: transfer.newOwnerId! },
//       });
//     } else {
//       // Get original boundary as WKT
//       const originalBoundary = await tx.$queryRaw<{ boundary: string }[]>`
//         SELECT ST_AsText(boundary) as boundary FROM "LandRegistration" WHERE id = ${transfer.landId}
//       `;
//       const originalWKT = originalBoundary[0]?.boundary;

//       // Create new land for transferred portion
//       const transferWKT = toWKTPolygon(
//         transfer.transferCoordinates as number[][],
//       );
//       const newLandId = crypto.randomUUID();

//       const existingUser = await prisma.user.findUnique({
//         where: {
//           id: transfer.newOwnerId!,
//         },
//       });
//       if (!existingUser) {
//         throw new Error("New owner user not found");
//       }

//       // Use same pattern as landController with proper column names and ST_ForceRHR
//       const [newLand] = await tx.$queryRaw<any[]>`
//         WITH geom AS (
//           SELECT ST_ForceRHR(ST_GeomFromText(${transferWKT}, 4326)) AS g
//         )
//         INSERT INTO "LandRegistration" (
//           "id",
//           "landCode",
//           "ownerId",
//           "ownerName",
//           "ownershipType",
//           "purpose",
//           "titleType",
//           "stateId",
//           "address",
//           "areaSqm",
//           "centerLat",
//           "centerLng",
//           "surveyType",
//           "utmZone",
//           "utmCoordinates",
//           "latlngCoordinates",
//           "startPoint",
//           "landStatus",
//           "boundary",
//           "isVerified",
//           "createdAt"
//         )
//         SELECT
//           ${newLandId},
//           ${`SUB-${transfer.land.landCode || "UNKNOWN"}-${Date.now()}`},
//           ${transfer.newOwnerId},
//           ${existingUser?.fullName || "Unknown Owner"},
//           ${transfer.land.ownershipType},
//           ${transfer.land.purpose},
//           ${transfer.land.titleType},
//           ${transfer.land.stateId},
//           ${transfer.land.address},
//           ${transfer.transferAreaSqm},
//           ST_Y(ST_Centroid(g)),
//           ST_X(ST_Centroid(g)),
//           ${transfer.transferSurveyType || "COORDINATE"},
//           ${transfer.transferUtmZone},
//           CAST(${JSON.stringify(transfer.transferCoordinates ?? [])} AS jsonb),
//           CAST(${JSON.stringify(transfer.transferCoordinates ?? [])} AS jsonb),
//           CAST(${JSON.stringify(transfer.transferStartPoint ?? null)} AS jsonb),
//           'APPROVED',
//           g,
//           true,
//           now()
//         FROM geom
//         RETURNING *;
//       `;

//       // Update original land boundary (subtract transferred area) AND recalculate coordinates
//       // After partial transfer, the land shape changes, so we need to:
//       // 1. Update the boundary geometry
//       // 2. Recalculate the area from the new boundary (using geographic calculation for proper square meter calculation)
//       // 3. Recalculate the center coordinates
//       await tx.$queryRaw`
//         WITH updated_boundary AS (
//           SELECT
//             ST_Difference("boundary", ST_GeomFromText(${transferWKT}, 4326)) as new_geom
//           FROM "LandRegistration"
//           WHERE "id" = ${transfer.landId}
//         )
//         UPDATE "LandRegistration"
//         SET "boundary" = updated_boundary.new_geom,
//             "areaSqm" = ROUND(ST_Area(updated_boundary.new_geom, true)::numeric, 2),
//             "centerLat" = ST_Y(ST_Centroid(updated_boundary.new_geom)),
//             "centerLng" = ST_X(ST_Centroid(updated_boundary.new_geom))
//         FROM updated_boundary
//         WHERE "id" = ${transfer.landId}
//       `;

//       // Link transferred land
//       await tx.ownershipTransfer.update({
//         where: { id: transferId },
//         data: { transferredLandId: newLandId },
//       });
//     }

//     // Create ownership history for the new land
//     await tx.ownershipHistory.create({
//       data: {
//         landId: transfer.landId,
//         fromUserId: transfer.currentOwnerId,
//         toUserId: transfer.newOwnerId!,
//         authorizedBy: governorId,
//         transferDate: new Date(),
//       },
//     });

//     // Update transfer status
//     await tx.ownershipTransfer.update({
//       where: { id: transferId },
//       data: {
//         status: "APPROVED",
//         governorId,
//         reviewedAt: new Date(),
//         governorComment: comment,
//       },
//     });

//     // Audit log
//     await tx.ownershipTransferAuditLog.create({
//       data: {
//         transferId,
//         action: "APPROVED",
//         performedById: governorId,
//         performedByRole: "GOVERNOR",
//         comment,
//       },
//     });
//   });
// }
function coordinatesToBearings(utmCoords: number[][]) {
  const bearings: { distance: number; bearing: number }[] = [];

  for (let i = 0; i < utmCoords.length - 1; i++) {
    const [e1, n1] = utmCoords[i];
    const [e2, n2] = utmCoords[i + 1];

    const deltaE = e2 - e1;
    const deltaN = n2 - n1;

    const distance = Math.sqrt(deltaE ** 2 + deltaN ** 2);

    let bearing = (Math.atan2(deltaE, deltaN) * 180) / Math.PI;
    bearing = (bearing + 360) % 360;

    bearings.push({
      distance: Number(distance.toFixed(2)),
      bearing: Number(bearing.toFixed(3)),
    });
  }

  return bearings;
}
async function finalizeTransfer(
  transferId: string,
  governorId: string,
  comment?: string,
) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: { land: true },
  });

  if (!transfer) return;

  const existingUser = await prisma.user.findUnique({
    where: {
      id: transfer.newOwnerId!,
    },
  });
  if (!existingUser) return;

  await prisma.$transaction(async (tx) => {
    if (transfer.transferType === "FULL") {
      await tx.landRegistration.update({
        where: { id: transfer.landId },
        data: { ownerId: transfer.newOwnerId! },
      });
      return;
    }

    const transferCoords = Array.isArray(transfer.transferCoordinates) 
      ? transfer.transferCoordinates as number[][] 
      : JSON.parse(transfer.transferCoordinates as string) as number[][];
    const transferBearings = Array.isArray(transfer.transferBearings) 
      ? transfer.transferBearings as { bearing: number; distance: number }[] 
      : JSON.parse(transfer.transferBearings as string) as { bearing: number; distance: number }[];

    // Validate transfer data
    if (!transferCoords || !Array.isArray(transferCoords) || transferCoords.some(coord => !Array.isArray(coord) || coord.length !== 2 || coord.some(n => !isFinite(n)))) {
      throw new Error("Invalid transfer coordinates");
    }
    if (!transferBearings || !Array.isArray(transferBearings) || transferBearings.some(b => !isFinite(b.bearing) || !isFinite(b.distance))) {
      throw new Error("Invalid transfer bearings");
    }

    const transferWKT = toWKTPolygon(transferCoords);

    // =========================
    // 1️⃣ CREATE NEW LAND
    // =========================
    const [newLand] = await tx.$queryRaw<any[]>`
      WITH geom AS (
        SELECT ST_ForceRHR(ST_GeomFromText(${transferWKT}, 4326)) AS g
      )
      INSERT INTO "LandRegistration" (
        "id",
        "ownerId",
        "ownerName",
        "ownershipType",
        "purpose",
        "titleType",
        "stateId",
        "boundary",
        "areaSqm",
        "centerLat",
        "centerLng",
        "latlngCoordinates",
        "utmCoordinates",
        "bearings",
        "surveyType",
        "startPoint",
        "utmZone",
        "landStatus",
        "createdAt"
      )
      SELECT
        gen_random_uuid(),
        ${transfer.newOwnerId},
        ${existingUser?.fullName || "Unknown Owner"},
        ${transfer.land.ownershipType},
        ${transfer.land.purpose},
        ${transfer.land.titleType},
        ${transfer.land.stateId},
        g,
        ST_Area(g::geography),
        ST_Y(ST_Centroid(g)),
        ST_X(ST_Centroid(g)),
        ${JSON.stringify(transferCoords)}::jsonb,
        ${JSON.stringify(transferCoords)}::jsonb, -- temp, will fix later
        ${JSON.stringify(transferBearings)}::jsonb,
        ${transfer.transferSurveyType},
        ${transfer.transferStartPoint},
        ${transfer.transferUtmZone},
        'APPROVED',
        now()
      FROM geom
      RETURNING *;
    `;

    // =========================
    // 2️⃣ CUT ORIGINAL LAND (SQL ONLY)
    // =========================
    await tx.$queryRaw`
      UPDATE "LandRegistration"
      SET "boundary" = ST_Difference(
        "boundary",
        ST_GeomFromText(${transferWKT}, 4326)
      )
      WHERE "id" = ${transfer.landId}
    `;

    // =========================
    // 3️⃣ FETCH UPDATED GEOMETRY
    // =========================
    const updated = await tx.$queryRaw<any[]>`
      SELECT 
        ST_AsGeoJSON(boundary) as geo,
        ST_Area(boundary::geography) as area,
        ST_Y(ST_Centroid(boundary)) as lat,
        ST_X(ST_Centroid(boundary)) as lng,
        ST_GeometryType(boundary) as type
      FROM "LandRegistration"
      WHERE id = ${transfer.landId}
    `;

    if (!updated.length) {
      throw new Error("Failed to fetch updated geometry");
    }

    if (updated[0].type !== "ST_Polygon") {
      throw new Error("Subdivision resulted in invalid geometry");
    }

    // =========================
    // 4️⃣ EXTRACT LAT/LNG
    // =========================
    const geo = JSON.parse(updated[0].geo);

    const newLatLng: number[][] = geo.coordinates[0].map(
      ([lng, lat]: number[]) => [lat, lng],
    );

    // Validate new coordinates
    if (!newLatLng || !Array.isArray(newLatLng) || newLatLng.some(coord => !Array.isArray(coord) || coord.length !== 2 || coord.some(n => !isFinite(n)))) {
      throw new Error("Invalid coordinates from updated geometry");
    }

    // =========================
    // 5️⃣ CONVERT TO UTM
    // =========================
    const utmZone = transfer.transferUtmZone;

    const newUTM = newLatLng.map(([lat, lng]) =>
      convertUTMToLatLng(lat, lng, utmZone as string, true),
    );

    // Validate UTM coordinates
    if (!newUTM || !Array.isArray(newUTM) || newUTM.some(coord => !Array.isArray(coord) || coord.length !== 2 || coord.some(n => !isFinite(n)))) {
      throw new Error("Invalid UTM coordinates from conversion");
    }

    // =========================
    // 6️⃣ 🔥 GENERATE NEW BEARINGS
    // =========================
    const newBearings = coordinatesToBearings(newUTM);

    // Validate bearings
    if (!newBearings || !Array.isArray(newBearings) || newBearings.some(b => !isFinite(b.bearing) || !isFinite(b.distance))) {
      throw new Error("Invalid bearings from new coordinates");
    }

    // =========================
    // 7️⃣ UPDATE ORIGINAL LAND (NO GEOMETRY HERE)
    // =========================
    await tx.landRegistration.update({
      where: { id: transfer.landId },
      data: {
        surveyType: transfer.transferSurveyType,
        areaSqm: updated[0].area,
        centerLat: updated[0].lat,
        centerLng: updated[0].lng,
        latlngCoordinates: newLatLng,
        utmCoordinates: newUTM,
        bearings: newBearings,
      },
    });

    // =========================
    // 8️⃣ FIX NEW LAND UTM + BEARINGS
    // =========================
    const newLandUTM = transferCoords.map(([lat, lng]) =>
      convertUTMToLatLng(lat, lng, utmZone as string, true),
    );

    // Validate new land UTM
    if (!newLandUTM || !Array.isArray(newLandUTM) || newLandUTM.some(coord => !Array.isArray(coord) || coord.length !== 2 || coord.some(n => !isFinite(n)))) {
      throw new Error("Invalid UTM coordinates for new land");
    }

    const newLandBearings = coordinatesToBearings(newLandUTM);

    // Validate new land bearings
    if (!newLandBearings || !Array.isArray(newLandBearings) || newLandBearings.some(b => !isFinite(b.bearing) || !isFinite(b.distance))) {
      throw new Error("Invalid bearings for new land");
    }

    await tx.landRegistration.update({
      where: { id: newLand.id },
      data: {
        utmCoordinates: newLandUTM,
        bearings: newLandBearings,
      },
    });

    // =========================
    // 9️⃣ FINALIZE TRANSFER
    // =========================
    await tx.ownershipTransfer.update({
      where: { id: transferId },
      data: {
        status: "APPROVED",
        governorId,
        transferredLandId: newLand.id,
        reviewedAt: new Date(),
        governorComment: comment,
      },
    });

    // =========================
    // 🔟 HISTORY
    // =========================
    await tx.ownershipHistory.create({
      data: {
        landId: transfer.landId,
        fromUserId: transfer.currentOwnerId,
        toUserId: transfer.newOwnerId!,
        authorizedBy: governorId,
        transferDate: new Date(),
      },
    });
  });
}

/* ===============================
   5.5. REJECT TRANSFER
================================ */

async function rejectTransfer(
  transferId: string,
  reviewerId: string,
  reason?: string,
) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: { currentReviewer: true },
  });

  if (!transfer) return;

  await prisma.ownershipTransfer.update({
    where: { id: transferId },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      reviewedAt: new Date(),
    },
  });

  // Audit log
  await prisma.ownershipTransferAuditLog.create({
    data: {
      transferId,
      action: "REJECTED",
      performedById: reviewerId,
      performedByRole: transfer.currentReviewer?.role || "APPROVER",
      comment: reason,
    },
  });
}

/* ===============================
   6. FORWARD TO NEXT REVIEWER
================================ */

async function forwardToNextReviewer(
  transferId: string,
  currentReviewerId: string,
  comment?: string,
) {
  const transfer = await prisma.ownershipTransfer.findUnique({
    where: { id: transferId },
    include: {
      land: { include: { state: true } },
      stages: { include: { approver: true }, orderBy: { stageNumber: "asc" } },
    },
  });

  if (!transfer) return;

  // Get the current reviewer's position
  const currentReviewer = await prisma.internalUser.findUnique({
    where: { id: currentReviewerId },
    select: { position: true },
  });

  if (!currentReviewer) return;

  const currentPosition = currentReviewer.position || 0;
  const nextPosition = currentPosition + 1;

  // Find next approver with higher position
  const nextApprover = await prisma.internalUser.findFirst({
    where: {
      stateId: transfer.land.stateId,
      role: "APPROVER",
      position: { gt: currentPosition },
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
    const previousStage = transfer.stages[transfer.stages.length - 1];
    if (previousStage) {
      await prisma.transferStageLog.update({
        where: { id: previousStage.id },
        data: {
          status: "APPROVED",
          approvedAt: new Date(),
          message: comment,
        },
      });
    }

    // Send notification to next approver
    const transferWithDetails = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: { include: { state: true } },
        currentOwner: true,
        documents: true,
      },
    });

    if (transferWithDetails) {
      await sendApproverNotification(
        nextApprover,
        transferWithDetails,
        "Transfer Forwarded for Your Review",
      );
    }
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

      // Update previous stage
      const previousStage = transfer.stages[transfer.stages.length - 1];
      if (previousStage) {
        await prisma.transferStageLog.update({
          where: { id: previousStage.id },
          data: {
            status: "APPROVED",
            approvedAt: new Date(),
            message: comment,
          },
        });
      }

      // Send notification to governor
      const transferWithDetails = await prisma.ownershipTransfer.findUnique({
        where: { id: transferId },
        include: {
          land: { include: { state: true } },
          currentOwner: true,
          documents: true,
        },
      });

      if (transferWithDetails) {
        await sendApproverNotification(
          governor,
          transferWithDetails,
          "Transfer Requires Governor Approval",
        );
      }
    }
  }
}

/* ===============================
   8. GET TRANSFERS FOR REVIEW
================================ */

export const getTransfersForReview = async (
  req: AuthRequest,
  res: Response,
) => {
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

function calculateTransferProgress(status: string): number {
  switch (status) {
    case "INITIATED":
      return 10;
    case "VERIFIED_BY_PARTIES":
      return 30;
    case "DOCUMENTS_UPLOADED":
      return 50;
    case "PENDING_GOVERNOR":
      return 75;
    case "APPROVED":
      return 100;
    case "REJECTED":
      return 0;
    case "EXPIRED":
      return 0;
    default:
      return 0;
  }
}

export const getUserTransfers = async (req: AuthRequest, res: Response) => {
  const userId = req.user.sub;

  try {
    const transfers = await prisma.ownershipTransfer.findMany({
      where: {
        OR: [{ currentOwnerId: userId }, { newOwnerId: userId }],
      },
      include: {
        land: { include: { state: true } },
        documents: true,
        stages: {
          include: { approver: true },
          orderBy: { stageNumber: "asc" },
        },
        transferAuditLogs: { orderBy: { createdAt: "desc" }, take: 5 },
        currentReviewer: true,
        governor: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const formattedTransfers = transfers.map((transfer) => {
      // Calculate progress percentage based on status
      const progressPercentage = calculateTransferProgress(transfer.status);

      // Get document statistics
      const totalDocuments = transfer.documents.length;
      const approvedDocuments = transfer.documents.filter(
        (d) => d.status === "APPROVED",
      ).length;
      const rejectedDocuments = transfer.documents.filter(
        (d) => d.status === "REJECTED",
      ).length;
      const pendingDocuments = transfer.documents.filter(
        (d) => d.status === "PENDING",
      ).length;

      // Format stages
      const stages = transfer.stages.map((stage) => ({
        stage: `Stage ${stage.stageNumber}`,
        completed: stage.approvedAt !== null,
        completedAt: stage.approvedAt?.toISOString(),
        progress: stage.approvedAt ? 100 : 0,
        details: {
          verified: approvedDocuments,
          total: totalDocuments,
          approved: approvedDocuments,
          rejected: rejectedDocuments,
          pending: pendingDocuments,
        },
        submittedDocuments: totalDocuments,
      }));

      // Format recent activity
      const recentActivity = transfer.transferAuditLogs.map((log) => ({
        action: log.action,
        date: log.createdAt.toISOString(),
        comment: log.comment || "",
      }));

      return {
        transferId: transfer.id,
        currentStatus: transfer.status,
        progressPercentage,
        stages,
        landDetails: {
          id: transfer.land.id,
          address: transfer.land.address,
          size: transfer.land.areaSqm,
          state: transfer.land.state.name,
        },
        timestamps: {
          createdAt: transfer.createdAt.toISOString(),
          reviewedAt: transfer.reviewedAt?.toISOString() || null,
          expiresAt: transfer.expiresAt.toISOString(),
        },
        recentActivity,
      };
    });

    res.json({ transfers: formattedTransfers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfers" });
  }
};

export const getTransferProgress = async (req: AuthRequest, res: Response) => {
  const { transferId } = req.params;
  const userId = req.user.sub;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: { include: { state: true } },
        documents: true,
        stages: { orderBy: { stageNumber: "asc" } },
        verifications: true,
        transferAuditLogs: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    if (transfer.currentOwnerId !== userId && transfer.newOwnerId !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this transfer" });
    }

    const totalDocuments = transfer.documents.length;
    const approvedDocuments = transfer.documents.filter(
      (d) => d.status === "APPROVED",
    ).length;
    const rejectedDocuments = transfer.documents.filter(
      (d) => d.status === "REJECTED",
    ).length;
    const pendingDocuments = transfer.documents.filter(
      (d) => d.status === "PENDING",
    ).length;

    const verificationTargets = transfer.verifications.map((v) => ({
      target: v.target,
      channelType: v.channelType === "phone" ? "phone" : "email",
      isVerified: v.isVerified,
    }));

    const progressPercentage = calculateTransferProgress(transfer.status);

    const response = {
      transferId: transfer.id,
      currentStatus: transfer.status,
      progressPercentage,
      landDetails: {
        id: transfer.land.id,
        address: transfer.land.address,
        size: transfer.land.areaSqm,
        state: transfer.land.state.name,
      },
      timestamps: {
        createdAt: transfer.createdAt.toISOString(),
        reviewedAt: transfer.reviewedAt?.toISOString() || null,
        expiresAt: transfer.expiresAt.toISOString(),
      },
      stages: [
        {
          stage: "VERIFICATION",
          completed:
            verificationTargets.every((t) => t.isVerified) &&
            verificationTargets.length > 0,
          completedAt: transfer.reviewedAt?.toISOString() || null,
          progress: verificationTargets.every((t) => t.isVerified) ? 100 : 0,
          details: {
            targets: verificationTargets,
            total: verificationTargets.length,
            verified: verificationTargets.filter((t) => t.isVerified).length,
            pending: verificationTargets.filter((t) => !t.isVerified).length,
          },
          submittedDocuments: totalDocuments,
        },
        {
          stage: "DOCUMENTS",
          completed:
            transfer.status === "DOCUMENTS_UPLOADED" ||
            transfer.status === "PENDING_GOVERNOR" ||
            transfer.status === "APPROVED",
          completedAt: transfer.updatedAt.toISOString(),
          progress:
            transfer.status === "DOCUMENTS_UPLOADED" ||
            transfer.status === "PENDING_GOVERNOR" ||
            transfer.status === "APPROVED"
              ? 100
              : 0,
          details: {
            total: totalDocuments,
            approved: approvedDocuments,
            rejected: rejectedDocuments,
            pending: pendingDocuments,
          },
          submittedDocuments: totalDocuments,
        },
      ],
      recentActivity: transfer.transferAuditLogs.map((log) => ({
        action: log.action,
        date: log.createdAt.toISOString(),
        comment: log.comment || "",
      })),
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfer progress" });
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
        documents: {
          include: {
            reviewedBy: true,
            reviews: {
              include: {
                reviewer: true,
                document: true,
              },
            },
          },
        },
        stages: {
          include: { approver: true },
          orderBy: { stageNumber: "desc" },
        },
        verifications: true,
      },
    });

    if (!transfer) {
      return res
        .status(404)
        .json({ message: "Transfer not found or not assigned to you" });
    }

    res.json({ transfer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfer" });
  }
};

/* ===============================
   10.5. GET TRANSFER DETAILS
================================ */

export const getTransferDetails = async (req: AuthRequest, res: Response) => {
  const { transferId } = req.params;
  const userId = req.user.sub;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: {
        land: { include: { state: true } },
        currentOwner: true,
        newOwner: true,
        documents: { include: { reviewedBy: true } },
        stages: {
          include: { approver: true },
          orderBy: { stageNumber: "asc" },
        },
        verifications: true,
        transferAuditLogs: { orderBy: { createdAt: "desc" }, take: 10 },
        currentReviewer: true,
        governor: true,
      },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Check if user is authorized to view this transfer
    if (transfer.currentOwnerId !== userId && transfer.newOwnerId !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this transfer" });
    }

    // Format the response according to TransferDetailsResponse interface
    const response = {
      transferId: transfer.id,
      landId: transfer.landId,
      transferType: transfer.transferType as "FULL" | "PARTIAL",
      status: transfer.status,
      currentOwnerId: transfer.currentOwnerId,
      newOwnerEmail: transfer.newOwnerEmail,
      newOwnerPhone: transfer.newOwnerPhone,
      createdAt: transfer.createdAt.toISOString(),
      expiresAt: transfer.expiresAt.toISOString(),
      // Additional details
      landDetails: {
        id: transfer.land.id,
        address: transfer.land.address,
        sizeSqm: transfer.land.areaSqm,
        state: transfer.land.state.name,
        titleType: transfer.land.titleType,
      },
      newOwner: transfer.newOwner
        ? {
            id: transfer.newOwner.id,
            fullName: transfer.newOwner.fullName,
            email: transfer.newOwner.email,
            phone: transfer.newOwner.phone,
          }
        : null,
      currentOwner: {
        id: transfer.currentOwner.id,
        fullName: transfer.currentOwner.fullName,
        email: transfer.currentOwner.email,
        phone: transfer.currentOwner.phone,
      },
      transferDetails:
        transfer.transferType === "PARTIAL"
          ? {
              surveyType: transfer.transferSurveyType,
              coordinates: transfer.transferCoordinates,
              bearings: transfer.transferBearings,
              utmZone: transfer.transferUtmZone,
              areaSqm: transfer.transferAreaSqm,
              centerLat: transfer.transferCenterLat,
              centerLng: transfer.transferCenterLng,
            }
          : null,
      documents: transfer.documents.map((doc) => ({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        url: doc.url,
        status: doc.status,
        reviewedAt: doc.reviewedAt?.toISOString(),
        reviewedBy: doc.reviewedBy
          ? {
              id: doc.reviewedBy.id,
              name: doc.reviewedBy.name,
            }
          : null,
        rejectionMessage: doc.rejectionMessage,
      })),
      stages: transfer.stages.map((stage) => ({
        stageNumber: stage.stageNumber,
        status: stage.status,
        message: stage.message,
        arrivedAt: stage.arrivedAt.toISOString(),
        approvedAt: stage.approvedAt?.toISOString(),
        approver: {
          id: stage.approver.id,
          name: stage.approver.name,
          role: stage.approver.role,
        },
      })),
      verifications: transfer.verifications.map((v) => ({
        channelType: v.channelType,
        target: v.target,
        isVerified: v.isVerified,
        createdAt: v.createdAt.toISOString(),
        expiresAt: v.expiresAt.toISOString(),
      })),
      currentReviewer: transfer.currentReviewer
        ? {
            id: transfer.currentReviewer.id,
            name: transfer.currentReviewer.name,
            role: transfer.currentReviewer.role,
          }
        : null,
      governor: transfer.governor
        ? {
            id: transfer.governor.id,
            name: transfer.governor.name,
          }
        : null,
      governorComment: transfer.governorComment,
      reviewedAt: transfer.reviewedAt?.toISOString(),
      rejectionReason: transfer.rejectionReason,
      applicationNumber: transfer.applicationNumber,
      recentActivity: transfer.transferAuditLogs.map((log) => ({
        action: log.action,
        performedByRole: log.performedByRole,
        comment: log.comment,
        createdAt: log.createdAt.toISOString(),
      })),
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfer details" });
  }
};

/* ===============================
   11. UPLOAD TRANSFER DOCUMENTS
================================ */

export const uploadTransferDocuments = async (
  req: AuthRequest,
  res: Response,
) => {
  const { transferId } = req.params;
  const files = req.files as Express.Multer.File[];
  const userId = req.user.sub;

  // Validate body using schema
  const body = ownershipTransferDocumentUploadSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid document upload input",
      errors: body.error.flatten(),
    });
  }

  const { documentsMeta } = body.data;

  try {
    // Validate transfer
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { land: true },
    });

    if (!transfer || transfer.currentOwnerId !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (transfer.status !== "VERIFIED_BY_PARTIES") {
      return res
        .status(400)
        .json({ message: "Transfer must be verified first" });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No documents provided" });
    }

    // Parse metadata
    const docsMeta = documentsMeta;
    if (docsMeta.length !== files.length) {
      return res
        .status(400)
        .json({ message: "Metadata must match file count" });
    }

    // Validate files
    const validationErrors: string[] = [];
    files.forEach((file, i) => {
      const result = validateDocumentFile(
        file.buffer,
        file.originalname,
        file.mimetype,
      );
      if (!result.valid) {
        validationErrors.push(`File ${i + 1}: ${result.error}`);
      }
    });
    if (validationErrors.length) {
      return res
        .status(400)
        .json({ message: "Invalid files", errors: validationErrors });
    }

    // Upload files and create records
    const uploadedDocs = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const meta = docsMeta[i];

      const uploaded = await uploadToCloudinary(
        file.buffer,
        file.originalname,
        file.mimetype,
        { folder: `ownership_transfers/${transferId}` },
      );

      const doc = await prisma.ownershipTransferDocument.create({
        data: {
          transferId,
          type: meta.type,
          title: meta.title,
          url: uploaded.secure_url,
          status: "PENDING",
        },
      });
      uploadedDocs.push(doc);
    }

    // For partial transfers, auto-generate survey document
    if (transfer.transferType === "PARTIAL") {
      const surveyDoc = await generateSurveyDocument(transfer);
      uploadedDocs.push(surveyDoc);
    }

    // Check if all mandatory documents are uploaded
    const mandatoryDocs = getMandatoryDocuments(transfer.transferType);
    const uploadedTypes = uploadedDocs.map((d) => d.type);
    const missingDocs = mandatoryDocs.filter(
      (type) => !uploadedTypes.includes(type),
    );

    if (missingDocs.length > 0) {
      return res.status(400).json({
        message: "Missing mandatory documents",
        missing: missingDocs,
        uploaded: uploadedDocs,
      });
    }

    // Update transfer status
    await prisma.ownershipTransfer.update({
      where: { id: transferId },
      data: { status: "DOCUMENTS_UPLOADED" },
    });

    // Start approval workflow
    await startApprovalWorkflow(transferId);

    res.status(201).json({
      message: "Documents uploaded successfully",
      documents: uploadedDocs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Upload failed" });
  }
};

/* ===============================
   12. GENERATE SURVEY DOCUMENT
================================ */

async function generateSurveyDocument(transfer: any) {
  // This would generate a PDF survey document
  // For now, create a placeholder document record
  const surveyData = {
    landId: transfer.landId,
    transferId: transfer.id,
    boundary: transfer.transferCoordinates,
    area: transfer.transferAreaSqm,
    surveyType: transfer.transferSurveyType,
    bearings: transfer.transferBearings,
    utmZone: transfer.transferUtmZone,
  };

  // In a real implementation, you'd generate a PDF here
  // For now, we'll store the data as JSON
  const doc = await prisma.ownershipTransferDocument.create({
    data: {
      transferId: transfer.id,
      type: "SURVEY_DOCUMENT",
      title: "Auto-Generated Survey Document",
      url: JSON.stringify(surveyData), // In real implementation, upload PDF URL
      status: "APPROVED", // Auto-approved since system generated
    },
  });

  return doc;
}

/* ===============================
   13. GET MANDATORY DOCUMENTS
================================ */

function getMandatoryDocuments(transferType: string): string[] {
  const baseDocs = [
    "TRANSFER_AGREEMENT",
    "ID_DOCUMENT_CURRENT_OWNER",
    "ID_DOCUMENT_NEW_OWNER",
    "PAYMENT_RECEIPT",
    "SURVEY_DOCUMENT", // Required for both, but auto-generated for partial
  ];

  if (transferType === "PARTIAL") {
    return [...baseDocs, "SUBDIVISION_AGREEMENT", "UPDATED_TITLE_DOCUMENT"];
  }

  return baseDocs;
}

/* ===============================
   18. GET USER OWNERSHIP TRANSFERS
================================ */

export const getUserOwnershipTransfers = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user.sub;

  try {
    const transfers = await prisma.ownershipTransfer.findMany({
      where: {
        OR: [{ currentOwnerId: userId }, { newOwnerId: userId }],
      },
      include: {
        land: true,
        documents: true,
        stages: { include: { approver: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ transfers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfers" });
  }
};

/* ===============================
   19. REJECT OWNERSHIP TRANSFER
================================ */

export const rejectOwnershipTransfer = async (
  req: AuthRequest,
  res: Response,
) => {
  const { transferId } = req.params;
  const { reason } = req.body;
  const governorId = req.user.id;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { land: true },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Check if governor can review this transfer
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
      include: { state: true },
    });

    if (
      !governor ||
      governor.role !== "GOVERNOR" ||
      governor.stateId !== transfer.land.stateId
    ) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await prisma.ownershipTransfer.update({
      where: { id: transferId },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        reviewedAt: new Date(),
      },
    });

    // Audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId,
        action: "REJECTED",
        performedById: governorId,
        performedByRole: "GOVERNOR",
        comment: reason,
      },
    });

    res.json({ message: "Transfer rejected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Rejection failed" });
  }
};

/* ===============================
   20. APPROVE OWNERSHIP TRANSFER
================================ */

export const approveOwnershipTransfer = async (
  req: AuthRequest,
  res: Response,
) => {
  const { transferId } = req.params;
  const governorId = req.user.id;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId },
      include: { land: true },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    // Check if governor can review this transfer
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
      include: { state: true },
    });

    if (
      !governor ||
      governor.role !== "GOVERNOR" ||
      governor.stateId !== transfer.land.stateId
    ) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Finalize the transfer
    await finalizeTransfer(transferId, governorId);

    res.json({ message: "Transfer approved and completed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Approval failed" });
  }
};

/* ===============================
   21. RESEND TRANSFER OTP
================================ */

export const resendTransferOTP = async (req: AuthRequest, res: Response) => {
  const { transferId } = req.params;
  const userId = req.user.sub;

  try {
    const transfer = await prisma.ownershipTransfer.findUnique({
      where: { id: transferId, currentOwnerId: userId },
      include: { verifications: true },
    });

    if (!transfer) {
      return res.status(404).json({ message: "Transfer not found" });
    }

    if (transfer.status !== "INITIATED") {
      return res
        .status(400)
        .json({ message: "Cannot resend OTP at this stage" });
    }

    // Generate new codes and resend
    const newExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const verificationUpdates = [];

    for (const verification of transfer.verifications) {
      const newCode = crypto.randomInt(100000, 999999).toString();
      verificationUpdates.push({
        id: verification.id,
        code: newCode,
        expiresAt: newExpiresAt,
      });

      // Resend verification
      if (verification.channelType === "email") {
        await sendEmail(
          verification.target,
          "Land Ownership Transfer - Verification (Resent)",
          `<p>Your new verification code: <strong>${newCode}</strong></p>`,
        );
      }
    }

    // Update all verifications
    for (const update of verificationUpdates) {
      await prisma.transferVerification.update({
        where: { id: update.id },
        data: { code: update.code, expiresAt: update.expiresAt },
      });
    }

    // Update transfer expiry
    await prisma.ownershipTransfer.update({
      where: { id: transferId },
      data: { expiresAt: newExpiresAt },
    });

    res.json({ message: "OTP resent", expiresAt: newExpiresAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to resend OTP" });
  }
};

/* ===============================
   13. APPROVE DOCUMENT
================================ */

export const approveDocument = async (req: AuthRequest, res: Response) => {
  const { documentId } = req.params;
  const reviewerId = req.user.id;

  try {
    const document = await prisma.ownershipTransferDocument.findUnique({
      where: { id: documentId },
      include: {
        transfer: { include: { currentReviewer: true } },
      },
    });

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (document.transfer.currentReviewerId !== reviewerId) {
      return res
        .status(403)
        .json({ message: "Not authorized to review this document" });
    }

    // Check if reviewer has already reviewed this document
    const existingReview = await prisma.documentReview.findUnique({
      where: {
        documentId_reviewerId: {
          documentId,
          reviewerId,
        },
      },
    });

    if (existingReview) {
      return res
        .status(400)
        .json({ message: "You have already reviewed this document" });
    }

    // Create document review
    await prisma.documentReview.create({
      data: {
        documentId,
        reviewerId,
        status: "APPROVED",
      },
    });

    // Only update the actual document status when the governor approves it.
    if (document.transfer.currentReviewer?.role === "GOVERNOR") {
      await prisma.ownershipTransferDocument.update({
        where: { id: documentId },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          reviewedById: reviewerId,
        },
      });
    }

    // Audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId: document.transferId,
        action: "DOCUMENT_APPROVED",
        performedById: reviewerId,
        performedByRole: "APPROVER",
        comment: `Document ${document.title} approved by reviewer`,
      },
    });

    res.json({ message: "Document approved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Document approval failed" });
  }
};

/* ===============================
   14. REJECT DOCUMENT
================================ */

export const rejectDocument = async (req: AuthRequest, res: Response) => {
  const { documentId } = req.params;
  const { reason } = req.body;
  const reviewerId = req.user.id;

  try {
    const document = await prisma.ownershipTransferDocument.findUnique({
      where: { id: documentId },
      include: {
        transfer: { include: { currentReviewer: true } },
      },
    });

    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    if (document.transfer.currentReviewerId !== reviewerId) {
      return res
        .status(403)
        .json({ message: "Not authorized to review this document" });
    }

    // Check if reviewer has already reviewed this document
    const existingReview = await prisma.documentReview.findUnique({
      where: {
        documentId_reviewerId: {
          documentId,
          reviewerId,
        },
      },
    });

    if (existingReview) {
      return res
        .status(400)
        .json({ message: "You have already reviewed this document" });
    }

    // Create document review
    await prisma.documentReview.create({
      data: {
        documentId,
        reviewerId,
        status: "REJECTED",
        rejectionMessage: reason,
      },
    });

    // Update document status to REJECTED immediately on any rejection.
    await prisma.ownershipTransferDocument.update({
      where: { id: documentId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedById: reviewerId,
        rejectionMessage: reason,
      },
    });

    // Audit log
    await prisma.ownershipTransferAuditLog.create({
      data: {
        transferId: document.transferId,
        action: "DOCUMENT_REJECTED",
        performedById: reviewerId,
        performedByRole: "APPROVER",
        comment: `Document ${document.title} rejected: ${reason}`,
      },
    });

    res.json({ message: "Document rejected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Document rejection failed" });
  }
};

/* ===============================
   13. LIST TRANSFERS FOR GOVERNOR
================================ */

export const listTransfersForGovernor = async (
  req: AuthRequest,
  res: Response,
) => {
  const governorId = req.user.id;

  try {
    // Verify the user is a governor
    const governor = await prisma.internalUser.findUnique({
      where: { id: governorId },
      include: { state: true },
    });

    if (!governor || governor.role !== "GOVERNOR" || !governor.stateId) {
      return res.status(403).json({
        message: "Access denied. Governor role with assigned state required.",
      });
    }

    // Get all transfers for this governor's state
    const transfers = await prisma.ownershipTransfer.findMany({
      where: {
        land: {
          stateId: governor.stateId,
        },
        status: {
          in: ["PENDING_GOVERNOR", "APPROVED", "REJECTED"],
        },
      },
      include: {
        land: {
          include: {
            state: true,
          },
        },
        currentOwner: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        newOwner: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        documents: {
          select: {
            id: true,
            title: true,
            type: true,
            url: true,
            status: true,
            rejectionMessage: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Categorize transfers
    const pending = transfers.filter((t) => t.status === "PENDING_GOVERNOR");
    const approved = transfers.filter((t) => t.status === "APPROVED");
    const rejected = transfers.filter((t) => t.status === "REJECTED");

    // Format transfers for response
    const formatTransfer = (transfer: any) => ({
      id: transfer.id,
      status: transfer.status,
      createdAt: transfer.createdAt.toISOString(),
      land: {
        id: transfer.land.id,
        address: transfer.land.address,
        latitude: transfer.land.centerLat,
        longitude: transfer.land.centerLng,
        squareMeters: transfer.land.areaSqm,
        state: {
          id: transfer.land.state.id,
          name: transfer.land.state.name,
          governorId: governor.id,
        },
      },
      currentOwner: transfer.currentOwner,
      newOwnerEmail: transfer.newOwnerEmail,
      newOwnerPhone: transfer.newOwnerPhone,
      documents: transfer.documents.map((doc: any) => ({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        url: doc.url,
        status: doc.status,
        rejectionMessage: doc.rejectionMessage,
        transferId: transfer.id,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      })),
    });

    const response = {
      summary: {
        total: transfers.length,
        pending: pending.length,
        approved: approved.length,
        rejected: rejected.length,
      },
      transfers: {
        pending: pending.map(formatTransfer),
        approved: approved.map(formatTransfer),
        rejected: rejected.map(formatTransfer),
        all: transfers.map(formatTransfer),
      },
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch transfers" });
  }
};