import prisma from "../lib/prisma";
import { LandRegistration } from "../generated/client/client";
import {
  landRegistrationSchema,
  landVerificationSchema,
} from "../utils/zodSchemas";
import {
  uploadToCloudinary,
  validateDocumentFile,
} from "../services/uploadService";
import { Request, Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";
import {
  convertUTMToLatLng,
  bearingsToCoordinates,
  calculateAreaFromUTM,
  isClosed,
} from "../utils/germetry";

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

export const registerLand = async (req: AuthRequest, res: Response) => {
  // 1️⃣ Validate request body
  const body = landRegistrationSchema.safeParse(req.body);
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
      
      // Area is within tolerance, use the measured value
      finalAreaSqm = measuredAreaSqm;
      console.log(`✅ Area validated: Calculated ${calculatedArea.toFixed(2)} m², Using measured ${measuredAreaSqm.toFixed(2)} m²`);
    }

    // 5️⃣ Overlap check
    const overlap = await prisma.$queryRaw<any[]>`
      SELECT id FROM "LandRegistration"
      WHERE ST_Intersects(boundary, ST_GeomFromText(${polygon}, 4326))
      AND NOT ST_Touches(boundary, ST_GeomFromText(${polygon}, 4326))
    `;
    if (overlap.length > 0) {
      return res
        .status(400)
        .json({ message: "Land overlaps with existing land" });
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

    // 7️⃣ Insert land
    const [land] = await prisma.$queryRaw<any[]>`
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
        "utmZone"
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
        'PENDING',
        g,
        now(),
        false,
        ${utmZone}
      FROM geom
      RETURNING *;
    `;

    if (!land) {
      return res.status(500).json({ message: "Land registration failed" });
    }

    // 8️⃣ Validate and upload documents
    const files = req.files as Express.Multer.File[];
    const validationErrors: string[] = [];

    files.forEach((file, i) => {
      const result = validateDocumentFile(
        file.buffer,
        file.originalname,
        file.mimetype,
      );
      if (!result.valid)
        validationErrors.push(`File ${i + 1}: ${result.error}`);
    });
    if (validationErrors.length) {
      return res
        .status(400)
        .json({ message: "Invalid documents", errors: validationErrors });
    }

    const uploadedDocs = await Promise.all(
      files.map(async (file) => {
        const uploaded = await uploadToCloudinary(
          file.buffer,
          file.originalname,
          file.mimetype,
        );
        return prisma.landDocument.create({
          data: {
            landId: land.id,
            documentUrl: uploaded.secure_url,
            fileName: file.originalname,
          },
        });
      }),
    );

    // 9️⃣ Audit log
    await prisma.landAuditLog.create({
      data: {
        landId: land.id,
        action: "REGISTERED",
        userId,
        metadata: {
          ownerName,
          areaSqm: land.areaSqm,
          coordinates: finalLatLng,
        },
      },
    });

    return res.status(201).json({
      message: "Land registered successfully",
      land,
      documents: uploadedDocs,
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
  const parsed = landVerificationSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Invalid input",
      errors: parsed.error.flatten(),
    });
  }

  const { surveyType, coordinates, bearings, startPoint, utmZone, stateId } = parsed.data;

  try {
    let finalLatLng: number[][];

    if (surveyType === "COORDINATE") {
      const normalized = normalizeLatLngOrder(coordinates! as number[][]);
      finalLatLng = closePolygon(normalized);
    } else {
      const result = bearingsToCoordinates(
        bearings! as { distance: number; bearing: number }[],
        utmZone!,
        startPoint as [number, number],
        false,
      );
      finalLatLng = closePolygon(result.latlngCoordinates);
    }

    const polygon = convertToWKT(finalLatLng);

    // 🔥 MAIN GIS QUERY
    const lands = await prisma.$queryRawUnsafe<
      {
        id: string;
        ownerId: string;
        ownerName: string;
        ownershipType: string;
        landStatus: string;
        purpose: string;
        titleType: string;
        stateId: string;
        ownerEmail: string | null;
        ownerPhone: string | null;
        ownerFullName: string | null;
      }[]
    >(
      `
      SELECT
        lr.id,
        lr."ownerId",
        lr."ownerName",
        lr."ownershipType",
        lr."landStatus",
        lr.purpose,
        lr."titleType",
        lr."stateId",
        u.email AS "ownerEmail",
        u.phone AS "ownerPhone",
        u."fullName" AS "ownerFullName"
      FROM "LandRegistration" lr
      LEFT JOIN "User" u ON u.id = lr."ownerId"
      WHERE ST_Intersects(
        lr.boundary,
        ST_GeomFromText($1, 4326)
      )
      AND NOT ST_Touches(
        lr.boundary,
        ST_GeomFromText($1, 4326)
      )
      ${stateId ? `AND lr."stateId" = '${stateId}'` : ""}
      `,
      polygon,
    );

    const existingOwners = lands.map((land) => ({
      id: land.id,
      ownerId: land.ownerId,
      ownerName: land.ownerName,
      ownerFullName: land.ownerFullName,
      ownerEmail: land.ownerEmail,
      ownerPhone: land.ownerPhone,
      ownershipType: land.ownershipType,
      landStatus: land.landStatus,
      purpose: land.purpose,
      titleType: land.titleType,
      stateId: land.stateId,
      isGovernment:
        /gov/i.test(land.ownershipType || "") || /gov/i.test(land.ownerName || ""),
    }));

    let riskLevel: "SAFE" | "RISKY" | "GOVERNMENT" = "SAFE";
    if (lands.length > 0) {
      riskLevel = existingOwners.some((o) => o.isGovernment)
        ? "GOVERNMENT"
        : "RISKY";
    }

    return res.status(200).json({
      exists: lands.length > 0,
      overlap: lands.length > 0,
      riskLevel,
      totalMatches: lands.length,
      existingOwners,
      coordinates: finalLatLng,
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
