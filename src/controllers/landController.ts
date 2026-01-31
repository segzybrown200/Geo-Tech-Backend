import prisma from "../lib/prisma";
import { landRegistrationSchema } from "../utils/zodSchemas";
import { uploadToCloudinary, validateDocumentFile } from "../services/uploadService";
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

  const { ownerName, latitude, longitude, squareMeters, ownershipType, purpose, titleType, stateId, address } = body.data;
  const userId = req.user.sub;

  if (!req.files || !(req.files instanceof Array) || req.files.length === 0) {
    return res.status(400).json({ message: "No documents uploaded" });
  }

  // Validate each file before processing
  const files = req.files as Express.Multer.File[];
  const validationErrors: string[] = [];
  files.forEach((file, index) => {
    const validation = validateDocumentFile(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    if (!validation.valid) {
      validationErrors.push(`File ${index + 1} (${file.originalname}): ${validation.error}`);
    }
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({
      message: "Document validation failed",
      errors: validationErrors,
    });
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
        address,
        landStatus: "PENDING",
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

    // ✅ Upload land documents (memory buffers -> cloudinary stream)
    const uploadedDocs = await Promise.all(
      (req.files as Express.Multer.File[]).map(async (file) => {
        const buffer = (file as any).buffer as Buffer;
        const uploaded = await uploadToCloudinary(buffer, file.originalname, file.mimetype);
        return prisma.landDocument.create({
          data: {
            landId: land.id,
            documentUrl: (uploaded as any).secure_url,
            fileName: file.originalname,
          },
        });
      })
    );
    
    // ✅ Create audit log 
    await prisma.landAuditLog.create({
      data:{
        landId: land.id,
        action: "REGISTERED",
        userId: userId,
        metadata: { 
          ownerName,
          latitude,
          longitude,
        }
      }
    })

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
      return res.status(403).json({ message: "Forbidden: You do not own this land" });
    } 
    const associatedCofO = await prisma.cofOApplication.findFirst({
      where: { landId: landId, status: "APPROVED" },
    });
    if (associatedCofO) {
      return res.status(400).json({ message: "Cannot delete land with an approved Certificate of Occupancy" });
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
    return res.status(400).json({ message: "Invalid land input", errors: body.error.flatten() });
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
      return res.status(403).json({ message: "Forbidden: You do not own this land" });
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
          file.originalname
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
  }
  catch (err) {
    res.status(500).json({ message: "Error updating land", error: err });
  }
};
export const getLandCount = async (req: Request, res: Response) => {
  try {
    const count = await prisma.landRegistration.count();
    res.status(200).json({ count });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving land count", error: err });
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
      searchRadius
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
