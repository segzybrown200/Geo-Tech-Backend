import prisma from "../lib/prisma";
import { LandRegistration } from "../generated/client/client";
import {
  landRegistrationSchema,
  landRegistrationWithPaymentSchema,
  existingCofOUploadSchema,
  cofoReviewSchema,
  acknowledgeLandConflictSchema,
  paymentConfirmationSchema,
} from "../utils/zodSchemas";
import {
  uploadToCloudinary,
  validateDocumentFile,
} from "../services/uploadService";
import { sendEmail } from "../services/emailSevices";
import { Request, Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";
import {
  convertUTMToLatLng,
  bearingsToCoordinates,
  calculateAreaFromUTM,
  isClosed,
} from "../utils/germetry";
import {
  generateConflictDocumentText,
  createConflictRecord,
  generateConflictDocumentData,
} from "../services/conflictDocumentService";
import {
  calculateLandRegistrationFee,
  verifyPaystackReference,
  initializeLandRegistrationPayment,
} from "../services/paymentService";

function toWKTPolygon(coords: number[][]) {
  const formatted = coords
    .map(([lat, lng]) => `${lng} ${lat}`) // MUST be lng lat
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

async function getLandReviewers(stateId: string) {
  return prisma.internalUser.findMany({
    where: { stateId, role: "APPROVER" },
    orderBy: { position: "asc" },
  });
}

export const initiateLandPayment = async (req: AuthRequest, res: Response) => {
  try {
    const { areaSqm } = req.body;

    if (!areaSqm || typeof areaSqm !== "number" || areaSqm <= 0) {
      return res.status(400).json({
        message: "Valid areaSqm is required to calculate payment",
      });
    }

    const userId = req.user.sub;
    const fee = calculateLandRegistrationFee(areaSqm);

    const paymentResult = await initializeLandRegistrationPayment(userId, fee);

    return res.status(200).json({
      message: "Payment initialized successfully",
      fee,
      areaSqm,
      payment: {
        id: paymentResult.payment.id,
        reference: paymentResult.reference,
        amount: paymentResult.payment.amount,
        status: paymentResult.payment.status,
        authorization_url: paymentResult.authorization_url,
      },
    });
  } catch (error) {
    console.error("Error initiating land payment:", error);
    return res.status(500).json({
      message: "Failed to initiate payment",
    });
  }
};

export const registerLand = async (req: AuthRequest, res: Response) => {
  // 1️⃣ Validate request body with payment details
  const body = landRegistrationWithPaymentSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid land input",
      errors: body.error.flatten(),
    });
  }

  const {
    ownerName,
    ownershipType,
    purpose,
    titleType,
    stateId,
    address,
    parentLandId,
    surveyPlanNumber,
    surveyDate,
    surveyorName,
    surveyorAddress,
    surveyTelephone,
    surveyNotes,
    accuracyLevel,
    surveyType,
    coordinates,
    utmZone,
    bearings,
    startPoint,
    measuredAreaSqm,
    hasExistingCofO,
    existingCofONumber,
    existingCofOIssueDate,
    paymentReference,
    paymentAmount,
  } = body.data;

  const userId = req.user.sub;

  let parsedSurveyDate: Date | null = null;
  if (surveyDate) {
    parsedSurveyDate = new Date(surveyDate);
    if (Number.isNaN(parsedSurveyDate.getTime())) {
      return res.status(400).json({ message: "Invalid surveyDate format" });
    }
  }

  // 2️⃣ Validate surveyType and accuracyLevel
  if (!["COORDINATE", "BEARING"].includes(surveyType)) {
    return res.status(400).json({ message: "Invalid surveyType" });
  }
  if (!["SURVEYED", "SATELLITE", "USER_DRAWN"].includes(accuracyLevel)) {
    return res.status(400).json({ message: "Invalid accuracyLevel" });
  }

  let finalLatLng: number[][] = [];
  let finalUTM: number[][] = [];

  // 3️⃣ Process coordinates or bearings
  if (surveyType === "COORDINATE") {
    // Parse coordinates
    const parsedCoordinates =
      typeof coordinates === "string" ? JSON.parse(coordinates) : coordinates;

    if (!Array.isArray(parsedCoordinates) || parsedCoordinates.length < 4) {
      return res
        .status(400)
        .json({ message: "Polygon must have at least 4 points" });
    }

    // Normalize and validate
    const normalized = normalizeLatLngOrder(parsedCoordinates);
    for (const [lat, lng] of normalized) {
      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        return res.status(400).json({ message: "Invalid coordinate values" });
      }
    }

    finalLatLng = closePolygon(normalized);

    // Convert to UTM if utmZone provided
    if (!utmZone) {
      return res
        .status(400)
        .json({ message: "UTM zone is required for coordinate surveys" });
    }
    finalUTM = finalLatLng.map(([lat, lng]) =>
      convertUTMToLatLng(lat, lng, utmZone, true),
    ); // true = latlng -> utm
  } else if (surveyType === "BEARING") {
    if (!Array.isArray(bearings) || bearings.length < 3) {
      return res.status(400).json({ message: "At least 3 bearings required" });
    }
    if (!utmZone) {
      return res
        .status(400)
        .json({ message: "UTM zone is required for bearing surveys" });
    }
    // Convert bearings to coordinates (returns lat/lng & UTM)
    const result = bearingsToCoordinates(
      bearings,
      utmZone as string,
      startPoint as [number, number],
      true,
    );
    finalLatLng = closePolygon(result.latlngCoordinates);
    finalUTM = closePolygon(result.utmCoordinates);

    console.log("Final LatLng:", finalLatLng);
    console.log("Final UTM:", finalUTM);

    if (!isClosed(finalUTM)) {
      return res.status(400).json({
        message: "Polygon is not properly closed",
      });
    }
  }

  try {
    const polygon = toWKTPolygon(finalLatLng);
    console.log("WKT:", polygon);
    console.log("First point:", finalLatLng[0]);

    // 4️⃣ Validate geometry
    const validityCheck = await prisma.$queryRaw<any[]>`
      SELECT ST_IsValid(
  ST_MakeValid(ST_GeomFromText(${polygon}, 4326))
) as valid
    `;

    if (!validityCheck[0]?.valid) {
      return res.status(400).json({ message: "Invalid polygon shape" });
    }

    // 4️⃣.5️⃣ Validate area if user provided measured value
    const calculatedArea = calculateAreaFromUTM(finalUTM);
    let finalAreaSqm = calculatedArea; // Default to calculated
    const AREA_TOLERANCE = 10; // ±10 m² tolerance

    if (measuredAreaSqm) {
      const areaDifference = Math.abs(calculatedArea - measuredAreaSqm);
      if (areaDifference > AREA_TOLERANCE) {
        return res.status(400).json({
          message: `Area mismatch detected. Calculated: ${calculatedArea.toFixed(2)} m², Measured: ${measuredAreaSqm.toFixed(2)} m². Difference: ${areaDifference.toFixed(2)} m² (tolerance: ±${AREA_TOLERANCE} m²). Please verify your measured area from the survey document.`,
          calculatedArea: parseFloat(calculatedArea.toFixed(2)),
          measuredArea: measuredAreaSqm,
          difference: parseFloat(areaDifference.toFixed(2)),
        });
      }
      finalAreaSqm = measuredAreaSqm;
      console.log(`✅ Area validated: Calculated ${calculatedArea.toFixed(2)} m², Using measured ${measuredAreaSqm.toFixed(2)} m²`);
    }

    // 5️⃣ Overlap check
    const overlap = await prisma.$queryRaw<any[]>`
      WITH input_geom AS (
        SELECT ST_MakeValid(ST_GeomFromText(${polygon}, 4326)) AS g
      )
      SELECT id, "ownerName", "ownershipType", purpose, "titleType", "stateId", "ownerId", "landStatus", address
      FROM "LandRegistration", input_geom
      WHERE
        ST_Overlaps(boundary, g)
        OR (
          ST_Intersects(boundary, g)
          AND ST_Area(ST_Intersection(boundary, g)::geography) > 0.1
        )
    `;

    if (overlap.length > 0) {
      const existingConflicts = overlap.map((existing) => ({
        landId: existing.id,
        ownerName: existing.ownerName,
        ownershipType: existing.ownershipType,
        purpose: existing.purpose,
        titleType: existing.titleType,
        stateId: existing.stateId,
        landStatus: existing.landStatus,
        address: existing.address,
        ownerId: existing.ownerId,
      }));

      return res.status(400).json({
        message: "Land overlaps with existing registration(s)",
        canRegister: false,
        conflicts: {
          detected: true,
          count: overlap.length,
          details: existingConflicts,
        },
      });
    }

    // 6️⃣ Subdivision check
    if (parentLandId) {
      const insideParent = await prisma.$queryRaw<any[]>`
        SELECT id FROM "LandRegistration"
        WHERE id = ${parentLandId}
        AND ST_Covers(boundary, ST_GeomFromText(${polygon}, 4326))
      `;
      if (insideParent.length === 0) {
        return res
          .status(400)
          .json({ message: "Subdivision must be inside parent land" });
      }
    }

    // 7️⃣ Duplicate field check
    const duplicateIssues: Array<{ field: string; message: string }> = [];
    const existingPlan = await prisma.landRegistration.findFirst({
      where: { surveyPlanNumber },
    });
    if (existingPlan) {
      duplicateIssues.push({
        field: "surveyPlanNumber",
        message: "This survey plan number is already registered",
      });
    }

    if (hasExistingCofO && existingCofONumber) {
      const existingCofO = await prisma.landRegistration.findFirst({
        where: { existingCofONumber },
      });
      if (existingCofO) {
        duplicateIssues.push({
          field: "existingCofONumber",
          message: "This existing CofO number has already been used",
        });
      }
    }

    if (duplicateIssues.length > 0) {
      return res.status(400).json({
        message: "Duplicate or invalid registration details",
        canRegister: false,
        duplicateIssues,
      });
    }

    let currentReviewerId: string | null = null;
    if (hasExistingCofO) {
      const reviewers = await getLandReviewers(stateId);
      if (!reviewers || reviewers.length === 0) {
        return res.status(500).json({
          message: "No internal approvers configured for this state's existing CofO workflow",
        });
      }
      currentReviewerId = reviewers[0].id;
    }

    // 8️⃣ Verify payment reference before creating the land
    const paymentVerification = await verifyPaystackReference(paymentReference);
    if (!paymentVerification.success) {
      return res.status(400).json({
        message: "Payment verification failed",
        details: paymentVerification.message,
      });
    }

    if (typeof paymentVerification.amount !== "number" ||
      Math.abs(paymentVerification.amount - paymentAmount) > 0.01) {
      return res.status(400).json({
        message: "Payment amount does not match the verified transaction",
        expectedAmount: paymentAmount,
        verifiedAmount: paymentVerification.amount,
      });
    }

    const existingPayment = await prisma.payment.findUnique({
      where: { reference: paymentReference },
    });
    if (existingPayment && existingPayment.landId) {
      return res.status(400).json({
        message: "This payment reference has already been used for another land registration",
      });
    }
    if (existingPayment && existingPayment.userId !== userId) {
      return res.status(403).json({
        message: "Payment reference belongs to another user",
      });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ message: "At least one land document is required" });
    }

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
        .json({ message: "Invalid documents", errors: validationErrors });
    }

    const uploadedResults = await Promise.all(
      files.map(async (file) => {
        return uploadToCloudinary(file.buffer, file.originalname, file.mimetype);
      }),
    );

    const landStatus = hasExistingCofO
      ? "PENDING_REVIEWER_VERIFICATION"
      : "PENDING";

    const [land, payment, uploadedDocs] = await prisma.$transaction(async (tx) => {
      const [newLand] = await tx.$queryRaw<any[]>`
        WITH geom AS (
          SELECT ST_ForceRHR(ST_GeomFromText(${polygon}, 4326)) AS g
        )
        INSERT INTO "LandRegistration" (
          "id",
          "landCode",
          "ownerId",
          "ownerName",
          "ownershipType",
          "purpose",
          "titleType",
          "stateId",
          "address",
          "parentLandId",
          "areaSqm",
          "centerLat",
          "centerLng",
          "startPoint",
          "surveyPlanNumber",
          "surveyDate",
          "surveyorName",
          "surveyorAddress",
          "surveyTelephone",
          "surveyNotes",
          "accuracyLevel",
          "surveyType",
          "utmCoordinates",
          "latlngCoordinates",
          "bearings",
          "landStatus",
          "boundary",
          "createdAt",
          "isVerified",
          "utmZone",
          "hasExistingCofO",
          "existingCofONumber",
          "existingCofOIssueDate",
          "currentReviewerId",
          "requiresReviewerApproval"
        )
        SELECT
          gen_random_uuid(),
          ${`LAND-${Date.now()}-${Math.floor(Math.random() * 1000)}`},
          ${userId},
          ${ownerName},
          ${ownershipType},
          ${purpose},
          ${titleType},
          ${stateId},
          ${address},
          ${parentLandId ?? null},
          ${finalAreaSqm},
          ST_Y(ST_Centroid(g)),
          ST_X(ST_Centroid(g)),
          CAST(${JSON.stringify(startPoint ?? null)} AS jsonb),
          ${surveyPlanNumber},
          ${parsedSurveyDate},
          ${surveyorName},
          ${surveyorAddress ?? null},
          ${surveyTelephone ?? null},
          ${surveyNotes ?? null},
          ${accuracyLevel},
          ${surveyType},
          CAST(${JSON.stringify(finalUTM)} AS jsonb),
          CAST(${JSON.stringify(finalLatLng)} AS jsonb),
          CAST(${JSON.stringify(bearings ?? [])} AS jsonb),
          ${landStatus},
          g,
          now(),
          false,
          ${utmZone},
          ${hasExistingCofO},
          ${existingCofONumber ?? null},
          ${existingCofOIssueDate ? new Date(existingCofOIssueDate) : null},
          ${currentReviewerId ?? null},
          ${hasExistingCofO ? true : false}
        FROM geom
        RETURNING *;
      `;

      const paymentRecord = existingPayment
        ? await tx.payment.update({
            where: { id: existingPayment.id },
            data: {
              landId: newLand.id,
              amount: paymentAmount,
              status: "SUCCESS",
              provider: "PAYSTACK",
              type: "LAND_REGISTRATION",
            },
          })
        : await tx.payment.create({
            data: {
              userId,
              landId: newLand.id,
              amount: paymentAmount,
              provider: "PAYSTACK",
              reference: paymentReference,
              status: "SUCCESS",
              type: "LAND_REGISTRATION",
            },
          });

      const documentRecords = await Promise.all(
        uploadedResults.map((uploaded, i) => {
          return tx.landDocument.create({
            data: {
              landId: newLand.id,
              documentUrl: uploaded.secure_url,
              fileName: files[i].originalname,
            },
          });
        }),
      );

      return [newLand, paymentRecord, documentRecords];
    });

    // 🔟 Audit log
    await prisma.landAuditLog.create({
      data: {
        landId: land.id,
        action: "REGISTERED",
        userId,
        metadata: {
          ownerName,
          areaSqm: land.areaSqm,
          coordinates: finalLatLng,
          hasExistingCofO,
        },
      },
    });

    return res.status(201).json({
      message: "Land registered successfully. Payment has been verified and land is now created.",
      land: {
        id: land.id,
        landCode: land.landCode,
        ownerName: land.ownerName,
        areaSqm: land.areaSqm,
        landStatus: land.landStatus,
        hasExistingCofO,
      },
      payment: {
        id: payment.id,
        amount: payment.amount,
        reference: payment.reference,
        status: payment.status,
        message: "Payment has been verified for this registration",
      },
      documents: uploadedDocs,
      conflicts: null,
      requiresReviewerApproval: hasExistingCofO,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Registration failed" });
  }
};

function convertToWKT(coordinates: number[][]) {
  const points = coordinates.map(([lng, lat]) => `${lng} ${lat}`).join(",");
  return `POLYGON((${points}))`;
}

export const verifyLand = async (req: Request, res: Response) => {
  const parsed = landRegistrationSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Invalid land input",
      errors: parsed.error.flatten(),
    });
  }

  const {
    surveyType,
    coordinates,
    bearings,
    startPoint,
    utmZone,
    stateId,
    surveyPlanNumber,
    measuredAreaSqm,
    hasExistingCofO,
    existingCofONumber,
  } = parsed.data;

  try {
    let finalLatLng: number[][];
    let finalUTM: number[][] = [];

    if (surveyType === "COORDINATE") {
      const normalized = normalizeLatLngOrder(coordinates! as number[][]);
      finalLatLng = closePolygon(normalized);
      if (!utmZone) {
        return res.status(400).json({ message: "UTM zone is required" });
      }
      finalUTM = finalLatLng.map(([lat, lng]) =>
        convertUTMToLatLng(lat, lng, utmZone, true),
      );
    } else {
      const result = bearingsToCoordinates(
        bearings! as { distance: number; bearing: number }[],
        utmZone!,
        startPoint as [number, number],
        true,
      );
      finalLatLng = closePolygon(result.latlngCoordinates);
      finalUTM = closePolygon(result.utmCoordinates);

      if (!isClosed(finalUTM)) {
        return res.status(400).json({
          message: "Polygon is not properly closed",
        });
      }
    }

    const polygon = toWKTPolygon(finalLatLng);

    const validityCheck = await prisma.$queryRaw<any[]>`
      SELECT ST_IsValid(
        ST_MakeValid(ST_GeomFromText(${polygon}, 4326))
      ) as valid
    `;

    if (!validityCheck[0]?.valid) {
      return res.status(400).json({ message: "Invalid polygon shape" });
    }

    const calculatedArea = calculateAreaFromUTM(finalUTM);
    let finalAreaSqm = calculatedArea;
    const AREA_TOLERANCE = 10;

    if (measuredAreaSqm) {
      const areaDifference = Math.abs(calculatedArea - measuredAreaSqm);
      if (areaDifference > AREA_TOLERANCE) {
        return res.status(400).json({
          message: `Area mismatch detected. Calculated: ${calculatedArea.toFixed(2)} m², Measured: ${measuredAreaSqm.toFixed(2)} m². Difference: ${areaDifference.toFixed(2)} m² (tolerance: ±${AREA_TOLERANCE} m²). Please verify your measured area from the survey document.`,
          calculatedArea: parseFloat(calculatedArea.toFixed(2)),
          measuredArea: measuredAreaSqm,
          difference: parseFloat(areaDifference.toFixed(2)),
        });
      }
      finalAreaSqm = measuredAreaSqm;
    }

    const overlapIdsResult = await prisma.$queryRaw<{ id: string }[]>`
      WITH input_geom AS (
        SELECT ST_MakeValid(ST_GeomFromText(${polygon}, 4326)) AS g
      )
      SELECT id
      FROM "LandRegistration", input_geom
      WHERE
        ST_Overlaps(boundary, g)
        OR (
          ST_Intersects(boundary, g)
          AND ST_Area(ST_Intersection(boundary, g)::geography) > 0.1
        )
    `;

    const overlapIds = overlapIdsResult.map((row) => row.id);

    const overlapRecords = overlapIds.length > 0
      ? await prisma.landRegistration.findMany({
          where: { id: { in: overlapIds } },
          include: {
            owner: { select: { id: true, fullName: true, email: true, phone: true } },
            documents: true,
            OwnershipTransfer: {
              include: {
                documents: true,
                currentOwner: { select: { id: true, fullName: true, email: true, phone: true } },
                newOwner: { select: { id: true, fullName: true, email: true, phone: true } },
              },
            },
            CofOApplication: {
              include: { cofODocuments: true },
            },
          },
        })
      : [];

    const existingOwners = overlapRecords.map((land) => ({
      id: land.id,
      ownerId: land.ownerId,
      ownerName: land.ownerName,
      ownerFullName: land.owner?.fullName ?? null,
      ownerEmail: land.owner?.email ?? null,
      ownerPhone: land.owner?.phone ?? null,
      ownershipType: land.ownershipType,
      landStatus: land.landStatus,
      purpose: land.purpose,
      titleType: land.titleType,
      stateId: land.stateId,
      address: land.address,
      surveyPlanNumber: land.surveyPlanNumber,
      surveyDate: land.surveyDate,
      surveyorName: land.surveyorName,
      surveyorAddress: land.surveyorAddress,
      surveyTelephone: land.surveyTelephone,
      surveyNotes: land.surveyNotes,
      areaSqm: land.areaSqm,
      hasExistingCofO: land.hasExistingCofO,
      existingCofONumber: land.existingCofONumber,
      existingCofOIssueDate: land.existingCofOIssueDate,
      existingCofODocument: land.existingCofODocument,
      ownerContact: {
        ownerId: land.ownerId,
        name: land.owner?.fullName ?? null,
        email: land.owner?.email ?? null,
        phone: land.owner?.phone ?? null,
      },
      documents: land.documents.map((doc) => ({
        id: doc.id,
        documentUrl: doc.documentUrl,
        fileName: doc.fileName,
        isActive: doc.isActive,
        createdAt: doc.createdAt,
      })),
      ownershipTransfers: land.OwnershipTransfer.map((transfer) => ({
        id: transfer.id,
        transferType: transfer.transferType,
        status: transfer.status,
        applicationNumber: transfer.applicationNumber,
        currentOwnerId: transfer.currentOwnerId,
        newOwnerId: transfer.newOwnerId,
        currentOwner: {
          id: transfer.currentOwner?.id,
          fullName: transfer.currentOwner?.fullName,
          email: transfer.currentOwner?.email,
          phone: transfer.currentOwner?.phone,
        },
        newOwner: {
          id: transfer.newOwner?.id,
          fullName: transfer.newOwner?.fullName,
          email: transfer.newOwner?.email,
          phone: transfer.newOwner?.phone,
        },
        transferAreaSqm: transfer.transferAreaSqm,
        transferSurveyType: transfer.transferSurveyType,
        transferUtmZone: transfer.transferUtmZone,
        transferStartPoint: transfer.transferStartPoint,
        transferCoordinates: transfer.transferCoordinates,
        transferBearings: transfer.transferBearings,
        transferCenterLat: transfer.transferCenterLat,
        transferCenterLng: transfer.transferCenterLng,
        transferDocuments: transfer.documents.map((doc) => ({
          id: doc.id,
          type: doc.type,
          title: doc.title,
          url: doc.url,
          status: doc.status,
          rejectionMessage: doc.rejectionMessage,
          reviewedById: doc.reviewedById,
          reviewedAt: doc.reviewedAt,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        })),
      })),
      cofOApplications: land.CofOApplication.map((app) => ({
        id: app.id,
        applicationNumber: app.applicationNumber,
        status: app.status,
        plotNumber: app.plotNumber,
        cofONumber: app.cofONumber,
        signedAt: app.signedAt,
        certificateUrl: app.certificateUrl,
        approvedById: app.approvedById,
        createdAt: app.createdAt,
        cofODocuments: app.cofODocuments?.map((doc) => ({
          id: doc.id,
          type: doc.type,
          title: doc.title,
          url: doc.url,
          status: doc.status,
          rejectionMessage: doc.rejectionMessage,
          createdAt: doc.createdAt,
        })),
      })),
    }));

    const overlapCount = overlapRecords.length;

    const surveyPlanDuplicate = await prisma.landRegistration.findFirst({
      where: { surveyPlanNumber },
    });
    const duplicateIssues: Array<{ field: string; message: string }> = [];
    if (surveyPlanDuplicate) {
      duplicateIssues.push({
        field: "surveyPlanNumber",
        message: "A land with this survey plan number already exists",
      });
    }

    if (hasExistingCofO && existingCofONumber) {
      const existingCofODuplicate = await prisma.landRegistration.findFirst({
        where: { existingCofONumber },
      });
      if (existingCofODuplicate) {
        duplicateIssues.push({
          field: "existingCofONumber",
          message: "This Certificate of Occupancy number is already on file",
        });
      }
    }

    const riskLevel: "SAFE" | "RISKY" | "GOVERNMENT" = overlapCount > 0
      ? existingOwners.some((o) => /gov/i.test(o.ownershipType || "") || /gov/i.test(o.ownerName || ""))
        ? "GOVERNMENT"
        : "RISKY"
      : "SAFE";

    return res.status(200).json({
      canRegister: overlapCount === 0 && duplicateIssues.length === 0,
      fee: calculateLandRegistrationFee(finalAreaSqm),
      areaSqm: finalAreaSqm,
      overlap: overlapCount > 0,
      totalMatches: overlapCount,
      conflicts: overlapCount > 0 ? existingOwners : [],
      duplicateIssues,
      riskLevel,
      requiresReviewerApproval: hasExistingCofO || overlapCount > 0,
      coordinates: finalLatLng,
      hasExistingCofO,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: "Land verification failed",
    });
  }
};
export const getLandById = async (req: Request, res: Response) => {
  const landId = req.params.id;
  try {
    const land = await prisma.landRegistration.findUnique({
      where: { id: landId },
      include: { documents: true },
    });
    if (!land) {
      return res.status(404).json({ message: "Land not found" });
    }
    res.status(200).json({ land });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving land", error: err });
  }
};

export const getAllUserLands = async (req: AuthRequest, res: Response) => {
  const userId = req.user.sub;
  try {
    const lands = await prisma.landRegistration.findMany({
      where: { ownerId: userId },
      include: { documents: true },
    });
    res.status(200).json({ lands });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving lands", error: err });
  }
};
export const getLandsByState = async (req: Request, res: Response) => {
  const stateId = req.params.stateId;
  try {
    const lands = await prisma.landRegistration.findMany({
      where: { stateId: stateId },
      include: { documents: true },
    });
    res.status(200).json({ lands });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving lands", error: err });
  }
};

export const getAllLands = async (req: Request, res: Response) => {
  try {
    const lands = await prisma.landRegistration.findMany({
      include: { documents: true },
    });
    res.status(200).json({ lands });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving lands", error: err });
  }
};
export const deleteLand = async (req: AuthRequest, res: Response) => {
  const landId = req.params.id;
  const userId = req.user.sub;
  try {
    const land = await prisma.landRegistration.findUnique({
      where: { id: landId },
    });
    if (!land) {
      return res.status(404).json({ message: "Land not found" });
    }

    if (land.ownerId !== userId) {
      return res
        .status(403)
        .json({ message: "Forbidden: You do not own this land" });
    }
    const associatedCofO = await prisma.cofOApplication.findFirst({
      where: { landId: landId, status: "APPROVED" },
    });
    if (associatedCofO) {
      return res.status(400).json({
        message: "Cannot delete land with an approved Certificate of Occupancy",
      });
    }
    await prisma.landRegistration.delete({
      where: { id: landId },
    });
    res.status(200).json({ message: "Land deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting land", error: err });
  }
};
export const updateLand = async (req: AuthRequest, res: Response) => {
  const landId = req.params.id;
  const userId = req.user.sub;

  const allowedSchema = landRegistrationSchema.pick({
    ownerName: true,
    ownershipType: true,
    purpose: true,
    titleType: true,
    address: true,
    plotNumber: true,
    surveyPlanNumber: true,
    surveyDate: true,
    surveyorName: true,
    surveyorAddress: true,
    surveyTelephone: true,
    surveyNotes: true,
    accuracyLevel: true,
    surveyType: true,
  });
  const body = allowedSchema.safeParse(req.body);
  if (!body.success) {
    return res
      .status(400)
      .json({ message: "Invalid land input", errors: body.error.flatten() });
  }
  try {
    const land = await prisma.landRegistration.findUnique({
      where: { id: landId },
      include: {
        documents: { where: { isActive: true } },
        CofOApplication: {
          where: { status: "APPROVED" },
          select: { id: true },
        },
      },
    });
    if (!land) {
      return res.status(404).json({ message: "Land not found" });
    }
    if (land.ownerId !== userId) {
      return res
        .status(403)
        .json({ message: "Forbidden: You do not own this land" });
    }
    const files = req.files as Express.Multer.File[] | undefined;
    await prisma.$transaction(async (tx) => {
      // Update land metadata
      if (Object.keys(body.data).length > 0) {
        await tx.landRegistration.update({
          where: { id: landId },
          data: body.data,
        });
      }

      if (files?.length) {
        for (const file of files) {
          const oldDocId = req.body.replaceDocumentId; // optional

          const uploaded = await uploadToCloudinary(
            file.buffer,
            file.originalname,
          );

          const newDoc = await tx.landDocument.create({
            data: {
              landId,
              documentUrl: uploaded.secure_url,
              fileName: file.originalname,
            },
          });
          if (oldDocId) {
            await tx.landDocument.updateMany({
              where: { id: oldDocId, landId },
              data: { isActive: false, replacedById: newDoc.id },
            });
          }
        }
      }
    });

    return res.status(200).json({ message: "Land updated successfully" });
  } catch (err) {
    res.status(500).json({ message: "Error updating land", error: err });
  }
};

export const getLandForReview = async (req: AuthRequest, res: Response) => {
  const reviewerId = req.user.id;
  const { id } = req.params;

  const reviewer = await prisma.internalUser.findUnique({
    where: { id: reviewerId },
  });
  if (!reviewer) {
    return res.status(403).json({ message: "Not an internal reviewer" });
  }

  const land = await prisma.landRegistration.findUnique({
    where: { id },
    include: {
      owner: true,
      state: true,
      documents: true,
      reviewLogs: { orderBy: { arrivedAt: "asc" } },
    },
  });

  if (!land) {
    return res.status(404).json({ message: "Land registration not found" });
  }

  if (land.stateId !== reviewer.stateId) {
    return res.status(403).json({ message: "Access denied" });
  }

  if (!land.hasExistingCofO || land.landStatus !== "PENDING_REVIEWER_VERIFICATION") {
    return res.status(400).json({
      message: "This land registration is not currently assigned for existing CofO review",
    });
  }

  if (land.currentReviewerId !== reviewerId) {
    return res.status(403).json({
      message: "You are not the assigned reviewer for this land registration",
    });
  }

  return res.json({ land });
};

export const reviewLand = async (req: AuthRequest, res: Response) => {
  const reviewerId = req.user.id;
  const { id } = req.params;
  const parse = cofoReviewSchema.safeParse(req.body);

  if (!parse.success) {
    return res.status(400).json({
      message: "Validation failed",
      errors: parse.error.flatten(),
    });
  }

  const { action, message } = parse.data;

  const reviewer = await prisma.internalUser.findUnique({
    where: { id: reviewerId },
  });
  if (!reviewer) {
    return res.status(403).json({ message: "Not an internal reviewer" });
  }

  const land = await prisma.landRegistration.findUnique({
    where: { id },
    include: {
      owner: true,
      state: true,
      
      reviewLogs: { orderBy: { arrivedAt: "asc" } },
    },
  });

  if (!land) {
    return res.status(404).json({ message: "Land registration not found" });
  }

  if (land.stateId !== reviewer.stateId) {
    return res.status(403).json({ message: "Access denied" });
  }

  if (!land.hasExistingCofO || land.landStatus !== "PENDING_REVIEWER_VERIFICATION") {
    return res.status(400).json({
      message: "This land registration is not in review for existing CofO",
    });
  }

  if (land.currentReviewerId !== reviewerId) {
    return res.status(403).json({
      message: "You are not the assigned reviewer for this land registration",
    });
  }

  const reviewers = await getLandReviewers(land.stateId);
  if (!reviewers || reviewers.length === 0) {
    return res.status(500).json({
      message: "No approvers configured for this state",
    });
  }

  const currentIndex = reviewers.findIndex((user) => user.id === reviewerId);
  if (currentIndex === -1) {
    return res.status(500).json({
      message: "Reviewer not configured for this state",
    });
  }

  const stageNumber = (land.reviewLogs?.length ?? 0) + 1;
  const isLastReviewer = currentIndex === reviewers.length - 1;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.landReviewLog.create({
        data: {
          landId: land.id,
          stageNumber,
          internalUserId: reviewerId,
          status: action === "APPROVE" ? "APPROVED" : "REJECTED",
          message: message ?? null,
          approvedAt: action === "APPROVE" ? new Date() : null,
        },
      });

      if (action === "REJECT") {
        await tx.landRegistration.update({
          where: { id: land.id },
          data: {
            landStatus: "REJECTED",
            currentReviewerId: null,
            requiresReviewerApproval: false,
          },
        });

        await tx.landAuditLog.create({
          data: {
            landId: land.id,
            action: "REVIEW_REJECTED",
            userId: reviewerId,
            metadata: {
              message,
              reviewerName: reviewer.name,
            },
          },
        });
      } else {
        if (isLastReviewer) {
          await tx.landRegistration.update({
            where: { id: land.id },
            data: {
              landStatus: "APPROVED",
              currentReviewerId: null,
              requiresReviewerApproval: false,
            },
          });

          await tx.landAuditLog.create({
            data: {
              landId: land.id,
              action: "REVIEW_APPROVED",
              userId: reviewerId,
              metadata: {
                reviewerName: reviewer.name,
              },
            },
          });
        } else {
          const nextReviewer = reviewers[currentIndex + 1];
          await tx.landRegistration.update({
            where: { id: land.id },
            data: {
              currentReviewerId: nextReviewer.id,
            },
          });

          await tx.landAuditLog.create({
            data: {
              landId: land.id,
              action: "REVIEW_FORWARDED",
              userId: reviewerId,
              metadata: {
                nextReviewerId: nextReviewer.id,
                nextReviewerName: nextReviewer.name,
              },
            },
          });
        }
      }
    });

    if (action === "APPROVE" && !isLastReviewer) {
      const nextReviewer = reviewers[currentIndex + 1];
      if (nextReviewer.email) {
        try {
          await sendEmail(
            nextReviewer.email,
            "New land review assignment",
            `<p>Dear ${nextReviewer.name},</p><p>A land registration with an existing CofO is now assigned to you for review.</p><p><strong>Land code:</strong> ${land.landCode}</p><p>Please log in to the GeoTech internal portal to continue the review.</p>`,
          );
        } catch (sendErr) {
          console.warn("Failed to notify next reviewer", sendErr);
        }
      }
    }

    if (action === "APPROVE" && isLastReviewer) {
      if (land.owner?.email) {
        try {
          await sendEmail(
            land.owner.email,
            "Land registration approved",
            `<p>Dear ${land.owner.fullName || "Applicant"},</p><p>Your land registration with existing CofO has been approved.</p><p><strong>Land code:</strong> ${land.landCode}</p>`,
          );
        } catch (sendErr) {
          console.warn("Failed to notify land owner", sendErr);
        }
      }
    }

    return res.json({
      message: action === "APPROVE"
        ? isLastReviewer
          ? "Land approved successfully"
          : "Land approved and forwarded to next reviewer"
        : "Land review rejected",
    });
  } catch (err) {
    console.error("Land review failed", err);
    return res.status(500).json({ message: "Land review failed", error: err });
  }
};

// ============= NEW ENDPOINTS FOR PAYMENT & CONFLICTS =============

import { confirmPayment } from "../services/paymentService";
import { updateConflictStatus } from "../services/conflictDocumentService";

/**
 * Confirm payment for land registration
 * Transitions land from PAYMENT_PENDING to PENDING (ready for reviewer)
 */
export const confirmPaymentLand = async (req: AuthRequest, res: Response) => {
  const body = paymentConfirmationSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid request",
      errors: body.error.flatten(),
    });
  }

  const { paymentId, status } = body.data;
  const userId = req.user.sub;

  try {
    const result = await confirmPayment(paymentId, status);

    if (!result.success) {
      return res.status(400).json({
        message: result.message,
      });
    }

    // Audit log
    const payment = result.data;
    if (payment?.landId) {
      await prisma.landAuditLog.create({
        data: {
          landId: payment.landId,
          action: "PAYMENT_CONFIRMED",
          userId,
          metadata: {
            paymentId,
            status,
            amount: payment.amount,
          },
        },
      });
    }

    return res.status(200).json({
      message: "Payment confirmed successfully",
      payment: result.data,
    });
  } catch (err) {
    console.error("Error confirming payment:", err);
    return res.status(500).json({
      message: "Error confirming payment",
    });
  }
};

/**
 * Get all conflicts for a land
 */
export const getLandConflicts = async (req: Request, res: Response) => {
  const { landId } = req.params;

  try {
    const conflicts = await prisma.landConflict.findMany({
      where: {
        OR: [{ landId }, { conflictingLandId: landId }],
      },
      include: {
        land: {
          include: {
            owner: {
              select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        conflictingLand: {
          include: {
            owner: {
              select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });

    if (conflicts.length === 0) {
      return res.status(200).json({
        message: "No conflicts found",
        conflicts: [],
      });
    }

    return res.status(200).json({
      message: "Conflicts retrieved successfully",
      total: conflicts.length,
      conflicts,
    });
  } catch (err) {
    console.error("Error fetching conflicts:", err);
    return res.status(500).json({
      message: "Error retrieving conflicts",
    });
  }
};

/**
 * Acknowledge a land conflict
 */
export const acknowledgeLandConflict = async (
  req: AuthRequest,
  res: Response
) => {
  const body = acknowledgeLandConflictSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid request",
      errors: body.error.flatten(),
    });
  }

  const { conflictId, acknowledged } = body.data;
  const userId = req.user.sub;

  try {
    const conflict = await prisma.landConflict.findUnique({
      where: { id: conflictId },
      include: {
        land: true,
      },
    });

    if (!conflict) {
      return res.status(404).json({
        message: "Conflict not found",
      });
    }

    // Only the land owner can acknowledge a conflict
    const land = await prisma.landRegistration.findUnique({
      where: { id: conflict.landId },
    });

    if (land?.ownerId !== userId) {
      return res.status(403).json({
        message: "Forbidden: You do not have permission to acknowledge this conflict",
      });
    }

    // Update conflict status
    const newStatus = acknowledged ? "ACKNOWLEDGED" : "FLAGGED";
    const updatedConflict = await updateConflictStatus(conflictId, newStatus as any);

    // Audit log
    await prisma.landAuditLog.create({
      data: {
        landId: conflict.landId,
        action: `CONFLICT_${newStatus}`,
        userId,
        metadata: {
          conflictId,
          conflictingLandId: conflict.conflictingLandId,
          acknowledged,
        },
      },
    });

    return res.status(200).json({
      message: `Conflict ${newStatus.toLowerCase()} successfully`,
      conflict: updatedConflict,
    });
  } catch (err) {
    console.error("Error acknowledging conflict:", err);
    return res.status(500).json({
      message: "Error acknowledging conflict",
    });
  }
};

/**
 * Download/retrieve conflict document
 */
export const getConflictDocument = async (req: Request, res: Response) => {
  const { conflictId } = req.params;

  try {
    const conflict = await prisma.landConflict.findUnique({
      where: { id: conflictId },
      include: {
        land: {
          include: {
            owner: {
              select: {
                fullName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        conflictingLand: {
          include: {
            owner: {
              select: {
                fullName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });

    if (!conflict) {
      return res.status(404).json({
        message: "Conflict not found",
      });
    }

    // Generate conflict document data
    const conflictData = await generateConflictDocumentData(
      conflict.landId,
      conflict.conflictingLandId,
      conflict.conflictType as "OVERLAP" | "EXISTING_COFO"
    );

    if (!conflictData) {
      return res.status(500).json({
        message: "Error generating conflict document",
      });
    }

    // Generate document text
    const documentText = generateConflictDocumentText(conflictData);

    // Return document
    return res.status(200).json({
      message: "Conflict document retrieved successfully",
      document: {
        conflictId,
        conflictType: conflict.conflictType,
        status: conflict.status,
        documentUrl: conflict.conflictDocument,
        generatedAt: new Date().toISOString(),
        content: documentText,
        data: conflictData,
      },
    });
  } catch (err) {
    console.error("Error retrieving conflict document:", err);
    return res.status(500).json({
      message: "Error retrieving conflict document",
    });
  }
};
export const getLandCount = async (req: Request, res: Response) => {
  try {
    const count = await prisma.landRegistration.count();
    res.status(200).json({ count });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error retrieving land count", error: err });
  }
};

export const searchLandExistence = async (req: Request, res: Response) => {
  const { lat, lng, radius = 50, stateId } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({
      message: "Latitude and longitude are required",
    });
  }

  const latitude = Number(lat);
  const longitude = Number(lng);
  const searchRadius = Number(radius); // meters

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ message: "Invalid coordinates" });
  }

  try {
    const pointWKT = `POINT(${longitude} ${latitude})`;

    const lands = await prisma.$queryRawUnsafe<
      {
        id: string;
        latitude: number;
        longitude: number;
        areaSqm: number;
        purpose: string;
        titleType: string;
        stateId: string;
        ownershipType: string;
        ownerName: string;
      }[]
    >(
      `
      SELECT
        id,
        "centerLat" as latitude,
        "centerLng" as longitude,
        "areaSqm" as "squareMeters",
        purpose,
        "ownershipType",
        "titleType",
        "stateId",
        "ownerName"
      FROM "LandRegistration"
      WHERE ST_DWithin(
        boundary::geography,
        ST_GeomFromText($1, 4326)::geography,
        $2
      )
      ${stateId ? `AND "stateId" = '${stateId}'` : ""}
      `,
      pointWKT,
      searchRadius,
    );

    res.json({
      exists: lands.length > 0,
      count: lands.length,
      lands: lands.map((l) => ({
        id: l.id,
        latitude: l.latitude,
        longitude: l.longitude,
        squareMeters: l.areaSqm,
        purpose: l.purpose,
        titleType: l.titleType,
        stateId: l.stateId,
        ownershipType: l.ownershipType,
        ownerName: l.ownerName,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to search land records",
    });
  }
};
