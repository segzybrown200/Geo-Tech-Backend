
import bcrypt from "bcryptjs";
import prisma from "../src/lib/prisma";

async function main() {
  const email = "admin@geotech.gov.ng";
  const password = "Admin@123"; // change this after first login
  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = await prisma.internalUser.create({
    data: {
      email,
      name: "System Admin",
      role: "ADMIN",
      password: hashedPassword,
      isVerified: true, // skip verification for first admin
    },
  });

  console.log("✅ Admin created successfully:", admin.email);
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
