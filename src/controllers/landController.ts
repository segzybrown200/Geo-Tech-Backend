import fs from "fs";
import path from "path";
import prisma from "../lib/prisma";
import { landRegistrationSchema } from "../utils/zodSchemas";
import { uploadToCloudinary } from "../services/uploadService";
import { Request, Response } from "express";
import { AuthRequest } from "../middlewares/authMiddleware";

// helper function
function generateSquareBoundary(lat: number, lng: number, squareMeters: number) {
  const delta = Math.sqrt(squareMeters) / 111320; // ~meters per degree (equator)
  return `POLYGON((
    ${lng - delta} ${lat - delta},
    ${lng + delta} ${lat - delta},
    ${lng + delta} ${lat + delta},
    ${lng - delta} ${lat + delta},
    ${lng - delta} ${lat - delta}
  ))`;
}

export const registerLand = async (req: AuthRequest, res: Response) => {
  const body = landRegistrationSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ message: "Invalid land input", errors: body.error.flatten() });
  }

  const { ownerName, latitude, longitude, squareMeters, ownershipType, purpose, titleType, stateId } = body.data;
  console.log(req.user)
  const userId = req.user.sub;

  if (!req.files || !(req.files instanceof Array) || req.files.length === 0) {
    return res.status(400).json({ message: "No documents uploaded" });
  }

  try {
    // ✅ Create land polygon
    const polygon = generateSquareBoundary(latitude, longitude, squareMeters);

    // ✅ Check for overlap
    const overlap = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "LandRegistration" WHERE ST_Intersects(boundary, ST_GeomFromText($1, 4326))`,
      polygon,
      
    );

    if (overlap.length > 0) {
      return res.status(400).json({ message: "Land overlaps with an existing registration" });
    }

    // ✅ Save land (boundary set via raw update because Prisma client doesn't support PostGIS geometry types)
    const land = await prisma.landRegistration.create({
      data: {
        ownerId: userId,
        ownerName,
        latitude,
        longitude,
        squareMeters,
        ownershipType,
        purpose,
        titleType,
        stateId,
      },
    });

    // set boundary using raw SQL
    await prisma.$executeRawUnsafe(
      `UPDATE "LandRegistration" SET boundary = ST_GeomFromText($1, 4326) WHERE id = $2`,
      polygon,
      land.id
    );

    // ✅ Upload land documents
    const uploadedDocs = await Promise.all(
      req.files.map(async (file: Express.Multer.File) => {
        const uploaded = await uploadToCloudinary(file.path);
        fs.unlinkSync(path.resolve(file.path));
        return prisma.landDocument.create({
          data: {
            landId: land.id,
            documentUrl: uploaded.secure_url,
            fileName: file.originalname,
          },
        });
      })
    );

    res.status(201).json({
      message: "Land registered successfully",
      land,
      documents: uploadedDocs,
    });
  } catch (err) {
    console.log(err)
    res.status(500).json({ message: "Registration failed", error: err });
  }
};
