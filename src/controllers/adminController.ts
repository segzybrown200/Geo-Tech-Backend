import { Request, Response } from 'express';
import { PrismaClient, ApplicationStatus } from '@prisma/client';
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken"

const prisma = new PrismaClient();

export const getAllApplications = async (_req: Request, res: Response) => {
  try {
    const applications = await prisma.application.findMany({
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(applications);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch applications', error: err });
  }
};

export const updateApplicationStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!Object.values(ApplicationStatus).includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  try {
    const updated = await prisma.application.update({
      where: { id },
      data: { status },
    });
    res.json({ message: 'Status updated', updated });
  } catch (err) {
    res.status(500).json({ message: 'Update failed', error: err });
  }
};
export const createFirstAdmin = async (req: Request, res: Response) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ message: "Email, password, and full name are required" });
    }

    // Check if any admin already exists
    const existingAdmin = await prisma.internalUser.findFirst({
      where: { role: "ADMIN" },
    });

    if (existingAdmin) {
      return res.status(403).json({ message: "Admin already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create admin
    const newAdmin = await prisma.internalUser.create({
      data: {
        email,
        name: fullName as string,
        password: hashedPassword,
        role: "ADMIN",
        isVerified: true,
      },
    });

    return res.status(201).json({
      message: "First admin created successfully",
      admin: {
        id: newAdmin.id,
        email: newAdmin.email,
        role: newAdmin.role,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
export const loginAdmin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const admin = await prisma.internalUser.findUnique({ where: { email } });
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    if (admin.role !== "ADMIN")
      return res.status(403).json({ message: "Not authorized as admin" });

    if (!admin.isVerified)
      return res.status(403).json({
        message:
          "Email not verified. Please check your email to verify your account.",
      });

    const valid = await bcrypt.compare(password, admin.password || "");
    if (!valid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, type: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Admin login successful",
      token,
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
