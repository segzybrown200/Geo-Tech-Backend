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



function toWKTPolygon(coords: number[][]) {
  // Input format: [lat, lng]
  const formatted = coords.map(([lat, lng]) => `${lng} ${lat}`).join(",");
  return `POLYGON((${formatted}))`;
}

// 🔥 Ensure polygon is closed
function closePolygon(coords: number[][]) {
  const first = coords[0];
  const last = coords[coords.length - 1]; 

  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...coords, first];
  }

  return coords;
}

function normalizeLatLngOrder(coords: number[][]): number[][] {
  // If first value in tuple is outside valid latitude range, assume they're [lng, lat]
  const looksLikeLngLat = coords.some(
    ([lat, lng]) => Math.abs(lat) > 90 && Math.abs(lng) <= 90,
  );

  if (looksLikeLngLat) {
    return coords.map(([lat, lng]) => [lng, lat]);
  }

  return coords;
}

export const registerLand = async (req: AuthRequest, res: Response) => {
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
    coordinates,
    parentLandId,
    surveyPlanNumber,
    surveyDate,
    surveyorName,
    surveyorLicense,
    accuracyLevel,
  } = body.data; 

  const userId = req.user.sub;

  let parsedSurveyDate: Date | null = null;
  if (surveyDate) {
    parsedSurveyDate = new Date(surveyDate);
    if (Number.isNaN(parsedSurveyDate.getTime())) {
      return res.status(400).json({
        message: "Invalid surveyDate format",
      });
    }
  }

  // 🔥 Parse coordinates safely
  const parsedCoordinates =
    typeof req.body.coordinates === "string"
      ? JSON.parse(req.body.coordinates)
      : coordinates;

  if (!Array.isArray(parsedCoordinates)) {
    return res.status(400).json({ message: "Invalid coordinates format" });
  }

  if (parsedCoordinates.length < 4) {
    return res.status(400).json({
      message: "Polygon must have at least 4 points",
    });
  }

  const normalizedCoordinates = normalizeLatLngOrder(parsedCoordinates);

  // 🔥 Validate coordinate values (lat, lng)
  for (const [lat, lng] of normalizedCoordinates) {
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      lat < -90 || lat > 90 ||
      lng < -180 || lng > 180
    ) {
      return res.status(400).json({
        message: "Invalid coordinate values",
      }); 
    }
  }

  try {
    const closedCoords = closePolygon(normalizedCoordinates);
    const polygon = toWKTPolygon(closedCoords);

    // 🔥 Validate geometry
    const validityCheck = await prisma.$queryRaw<any[]>`
      SELECT ST_IsValid(ST_GeomFromText(${polygon}, 4326)) as valid
    `;

    if (!validityCheck[0]?.valid) {
      return res.status(400).json({
        message: "Invalid polygon shape (self-intersection or bad geometry)",
      });
    }

    // 🔥 Overlap check (strong)
    const overlap = await prisma.$queryRaw<any[]>`
      SELECT id FROM "LandRegistration"
      WHERE ST_Intersects(boundary, ST_GeomFromText(${polygon}, 4326))
      AND NOT ST_Touches(boundary, ST_GeomFromText(${polygon}, 4326))
    `;

    if (overlap.length > 0) {
      return res.status(400).json({
        message: "Land overlaps with an existing land",
      });
    }

    // 🔥 Subdivision check
    if (parentLandId) {
      const insideParent = await prisma.$queryRaw<any[]>`
        SELECT id FROM "LandRegistration"
        WHERE id = ${parentLandId}
        AND ST_Covers(boundary, ST_GeomFromText(${polygon}, 4326))
      `;

      if (insideParent.length === 0) {
        return res.status(400).json({
          message: "Subdivision must be inside parent land",
        });
      }
    }

    // 🔥 Insert with computed geometry values (BEST PRACTICE)
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
        "surveyorLicense",
        "accuracyLevel",
        "coordinates",
        "landStatus",
        "boundary",
        "createdAt",
        "isVerified"
      )
      SELECT
        gen_random_uuid(),
        ${`LAND-${Date.now()}`},
        ${userId},
        ${ownerName},
        ${ownershipType},
        ${purpose},
        ${titleType},
        ${stateId},
        ${address},
        ${parentLandId ?? null},
        -- Preferred area calculation with metric projection + fallback to geography
        COALESCE(
          NULLIF(ST_Area(ST_Transform(g, 3857)), 0),
          ST_Area(g::geography)
        ),
        ST_Y(ST_PointOnSurface(g)),
        ST_X(ST_PointOnSurface(g)),
        ${surveyPlanNumber},
        ${parsedSurveyDate},
        ${surveyorName},
        ${surveyorLicense ?? null},
        ${accuracyLevel},
        CAST(${JSON.stringify(normalizedCoordinates)} AS jsonb),
        'PENDING',
        g,
        now(),
        false
      FROM geom
      RETURNING *;
    `;

    if (!land) {
      return res.status(500).json({
        message: "Land registration failed",
      });
    }

    // 🔥 Validate uploaded documents
    const files = req.files as Express.Multer.File[];
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
      return res.status(400).json({
        message: "Invalid documents",
        errors: validationErrors,
      });
    }

    // 🔥 Upload documents
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

    // 🔥 Audit log
    await prisma.landAuditLog.create({
      data: {
        landId: land.id,
        action: "REGISTERED",
        userId,
        metadata: {
          ownerName,
          areaSqm: land.areaSqm,
          coordinates: normalizedCoordinates,
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
    return res.status(500).json({
      message: "Registration failed",
    });
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

  const { coordinates, stateId } = parsed.data;

  try {
    const polygon = convertToWKT(coordinates);

    // 🔥 MAIN GIS QUERY
    const lands = await prisma.$queryRawUnsafe<
      {
        id: string;
        ownerName: string;
        landStatus: string;
        purpose: string;
        titleType: string;
      }[]
    >(
      `
      SELECT 
        id,
        "ownerName",
        "landStatus",
        purpose,
        "titleType"
      FROM "LandRegistration"
      WHERE ST_Intersects(
        boundary,
        ST_GeomFromText($1, 4326)
      )
      ${stateId ? `AND "stateId" = '${stateId}'` : ""}
      `,
      polygon,
    );

    // 🔥 DETERMINE RISK LEVEL
    let riskLevel: "SAFE" | "RISKY" | "GOVERNMENT" = "SAFE";

    if (lands.length > 0) {
      riskLevel = "RISKY";

      const hasGovernment = lands.some((l) => l.landStatus === "REJECTED");

      const hasApproved = lands.some((l) => l.landStatus === "APPROVED");

      if (hasGovernment) {
        riskLevel = "GOVERNMENT";
      } else if (hasApproved) {
        riskLevel = "RISKY";
      }
    }

    return res.status(200).json({
      exists: lands.length > 0,
      overlap: lands.length > 0,
      riskLevel,
      totalMatches: lands.length,
      lands,
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
      return res
        .status(400)
        .json({
          message:
            "Cannot delete land with an approved Certificate of Occupancy",
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
        squareMeters: number;
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
        latitude,
        longitude,
        "squareMeters",
        purpose,
        "ownershipType",
        "titleType",
        "stateId"
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
        squareMeters: l.squareMeters,
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
