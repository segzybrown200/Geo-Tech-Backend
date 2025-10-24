import { PrismaClient } from "../src/generated/prisma";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // const email = "admin@geo-tech.com";
  // const password = "Admin@123";
  // const hashedPassword = await bcrypt.hash(password, 10);

  // const admin = await prisma.internalUser.create({
  //   data: {
  //     email,
  //     name: "System Admin",
  //     role: "ADMIN",
  //     password: hashedPassword,
  //     isVerified: true,
  //     stateId: "00000000-0000-0000-0000-000000000000"
  //   },
  // });

  // console.log("✅ Admin created successfully:", admin);


  const geojsonPath = path.join(__dirname, "seed", "nigeria_states.geojson");
  const geojson = JSON.parse(fs.readFileSync(geojsonPath, "utf8"));

  for (const feature of geojson.features) {
    const stateName = feature.properties.NAME_1; // may vary depending on dataset
    const geom = JSON.stringify(feature.geometry);

    console.log(`📍 Seeding state: ${stateName}`);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "State" (id, name, boundary)
       VALUES (gen_random_uuid(), $1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
       ON CONFLICT (name) DO NOTHING;`,
      stateName,
      geom,

    )
  }
}

main()
  .then(() => {
    console.log("✅ Nigeria states seeded successfully!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Error seeding states:", err);
    process.exit(1);
  });

  