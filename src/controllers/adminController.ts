import { Request, Response } from "express";
import {  ApplicationStatus } from "../generated/client/client";
import prisma from "../lib/prisma";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../middlewares/authMiddleware";


export const getAllApplications = async (_req: Request, res: Response) => {
  try {
    const applications = await prisma.application.findMany({
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(applications);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch applications", error: err });
  }
};

export const updateApplicationStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!Object.values(ApplicationStatus).includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    const updated = await prisma.application.update({
      where: { id },
      data: { status },
    });
    res.json({ message: "Status updated", updated });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err });
  }
};
export const createFirstAdmin = async (req: Request, res: Response) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password || !fullName) {
      return res
        .status(400)
        .json({ message: "Email, password, and full name are required" });
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

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.json({
      message: "Admin login successful",
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

export const refreshAdminToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const admin = await prisma.internalUser.findUnique({
      where: { id: userId },
    });
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    if (admin.role !== "ADMIN")
      return res.status(403).json({ message: "Not authorized as admin" });

    const newToken = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, type: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.json({
      message: "Token refreshed successfully",
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
export const getAllActivities = async (req:AuthRequest, res:Response) => {
  const logs = await prisma.stageLog.findMany({
    include: {
      approver: { select: { name: true, role: true, position: true } },
      cofO: { select: { cofONumber: true, status: true } },
    },
    orderBy: { arrivedAt: "desc" },
  });
  res.json(logs);
};
export const getAllInternalUser = async (req:AuthRequest, res:Response) => {
  const logs = await prisma.internalUser.findMany({
    include: {
      StageLog: true,
      state: true,
      StateGovernor: true
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(logs);
};
export const getAllUser = async (req:AuthRequest, res:Response) => {
  const logs = await prisma.user.findMany({
    include: {
      applications: true,
      CofOApplication: true,
      LandRegistration: true,
      OwnershipTransfer:true
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(logs);
};

export const getPayments = async (req:AuthRequest, res:Response) => {
  const payments = await prisma.cofOApplication.findMany({
    select: {
      id: true,
      cofONumber: true,
      user: { select: { fullName: true, email: true } },
      paymentStatus: true,
      paymentRef: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(payments);
};
export const getAnalytics = async (req:AuthRequest, res:Response) => {
  const totalApplications = await prisma.cofOApplication.count();
  const approved = await prisma.cofOApplication.count({ where: { status: "APPROVED" } });
  const rejected = await prisma.cofOApplication.count({ where: { status: "REJECTED" } });
  const pending = await prisma.cofOApplication.count({ where: { status: "PENDING" } });
  const review = await prisma.cofOApplication.count({ where: { status: "IN_REVIEW" } });
  const revenue = await prisma.cofOApplication.aggregate({
    _count: true,
    _sum: {
      paymentAmount: true,
     },
     where: { paymentStatus: "SUCCESS" },
  });
  res.json({ totalApplications, approved, rejected,pending,review, revenue });
};
