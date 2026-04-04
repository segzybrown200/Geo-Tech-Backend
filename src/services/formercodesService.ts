// // helper function
// // 🔥 Convert coordinates → WKT
// function toWKTPolygon(coords: number[][]) {
//   const formatted = coords.map(([lng, lat]) => `${lng} ${lat}`).join(",");
//   return `POLYGON((${formatted}))`;
// }

// function closePolygon(coords: number[][]) {
//   const first = coords[0];
//   const last = coords[coords.length - 1];

//   if (first[0] !== last[0] || first[1] !== last[1]) {
//     return [...coords, first];
//   }

//   return coords;
// }

// // 🔥 Calculate centroid for polygon coordinates


// export const registerLand = async (req: AuthRequest, res: Response) => {
//   const body = landRegistrationSchema.safeParse(req.body);

//   if (!body.success) {
//     return res.status(400).json({
//       message: "Invalid land input",
//       errors: body.error.flatten(),
//     });
//   }

//   const {
//     ownerName,
//     ownershipType,
//     purpose,
//     titleType,
//     stateId,
//     address,
//     coordinates, // 🔥 NEW
//     parentLandId, // 🔥 NEW
//   } = body.data;

//   const userId = req.user.sub;

// const parsedCoordinates =
//   typeof req.body.coordinates === "string"
//     ? JSON.parse(req.body.coordinates)
//     : coordinates;

// if (!Array.isArray(parsedCoordinates)) {
//   return res.status(400).json({ message: "Invalid coordinates format" });
// }



//   if (!parsedCoordinates || parsedCoordinates.length < 4) {
//     return res.status(400).json({
//       message: "Invalid polygon parsedCoordinates",
//     });
//   }
//     // 🔥 Validate coordinate values
//   for (const [lng, lat] of parsedCoordinates) {
//     if (
//       typeof lng !== "number" ||
//       typeof lat !== "number" ||
//       lng < -180 || lng > 180 ||
//       lat < -90 || lat > 90
//     ) {
//       return res.status(400).json({
//         message: "Invalid coordinate values",
//       });
//     }
//   }

//   try {
// const closedCoords = closePolygon(parsedCoordinates);
// const polygon = toWKTPolygon(closedCoords);

//     const validityCheck = await prisma.$queryRaw<any[]>`
//       SELECT ST_IsValid(ST_GeomFromText(${polygon}, 4326)) as valid
//     `;

//     if (!validityCheck[0]?.valid) {
//       return res.status(400).json({
//         message: "Invalid polygon shape (self-intersection or bad geometry)",
//       });
//     }


// // ✅ Correct overlap check
//     // 🔥 Overlap check (strong)
//     const overlap = await prisma.$queryRaw<any[]>`
//       SELECT id FROM "LandRegistration"
//       WHERE ST_Intersects(boundary, ST_GeomFromText(${polygon}, 4326))
//       AND NOT ST_Touches(boundary, ST_GeomFromText(${polygon}, 4326))
//     `;

//     // ✅ Overlap check (SAFE)


//     if (overlap.length > 0) {
//       return res.status(400).json({
//         message: "Land overlaps with an existing land",
//       });
//     }

//     // ✅ Subdivision check
//     // 🔥 Subdivision check
//     if (parentLandId) {
//       const insideParent = await prisma.$queryRaw<any[]>`
//         SELECT id FROM "LandRegistration"
//         WHERE id = ${parentLandId}
//         AND ST_Covers(boundary, ST_GeomFromText(${polygon}, 4326))
//       `;

//       if (insideParent.length === 0) {
//         return res.status(400).json({
//           message: "Subdivision must be inside parent land",
//         });
//       }
//     }

//     // ✅ Calculate area and centroid on the application side (safe + predictable)


//     // ✅ Create land with geometry in one operation
//     const [land] = await prisma.$queryRaw<LandRegistration[]>`
//       INSERT INTO "LandRegistration" (
//         "id", "landCode", "ownerId", "ownerName", "ownershipType",
//         "purpose", "titleType", "stateId", "address", "parentLandId",
//         "areaSqm", "centerLat", "centerLng", "landStatus", "boundary", "createdAt", "isVerified"
//       ) VALUES (
//         gen_random_uuid(),
//         ${`LAND-${Date.now()}`},
//         ${userId},
//         ${ownerName},
//         ${ownershipType},
//         ${purpose},
//         ${titleType},
//         ${stateId},
//         ${address},
//         ${parentLandId ?? null},
//         ST_Area(g::geography),
//         ST_Y(ST_PointOnSurface(g)),
//         ST_X(ST_PointOnSurface(g)),
//         g,
//         now(),
//         false
//       FROM geom
//       ) RETURNING *;
//     `;

//     if (!land) {
//       return res.status(500).json({ message: "Land registration failed" });
//     }

//     // ✅ Upload documents (reuse your logic)
//     const files = req.files as Express.Multer.File[];

    

//     const validationErrors: string[] = [];

//     files.forEach((file, i) => {
//       const result = validateDocumentFile(
//         file.buffer,
//         file.originalname,
//         file.mimetype,
//       );

//       if (!result.valid) {
//         validationErrors.push(`File ${i + 1}: ${result.error}`);
//       }
//     });

//     if (validationErrors.length) {
//       return res.status(400).json({
//         message: "Invalid documents",
//         errors: validationErrors,
//       });
//     }

//     const uploadedDocs = await Promise.all(
//       files.map(async (file) => {
//         const uploaded = await uploadToCloudinary(
//           file.buffer,
//           file.originalname,
//           file.mimetype,
//         );

//         return prisma.landDocument.create({
//           data: {
//             landId: land.id,
//             documentUrl: uploaded.secure_url,
//             fileName: file.originalname,
//           },
//         });
//       }),
//     );

//     // ✅ Audit log (UPDATED)
//     await prisma.landAuditLog.create({
//       data: {
//         landId: land.id,
//         action: "REGISTERED",
//         userId,
//         metadata: {
//           ownerName,
//           areaSqm: land.areaSqm,
//           coordinates: parsedCoordinates,
//         },
//       },
//     });

//     return res.status(201).json({
//       message: "Land registered successfully",
//       land,
//       documents: uploadedDocs,
//     });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({
//       message: "Registration failed",
//     });
//   }
// };