import { Request, Response } from "express";
import { PrismaClient, Role } from "@prisma/client";
import { internalUserSchema } from "../utils/zodSchemas";
import { uploadToCloudinary } from "../services/uploadService";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sendEmail } from "../services/emailSevices";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AuthRequest } from "../middlewares/authMiddleware";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET!;

export const createInternalUser = async (req: Request, res: Response) => {
  const body = internalUserSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid internal user input",
      errors: body.error.flatten(),
    });
  }

  const {
    name,
    email,
    phone,
    ministry,
    department,
    approvingPosition,
    function: workflowFunction,
    role,
    requiresSignature,
    signatureUrl,
    stateId,
  } = body.data;

  // Generate verification token (expires in 24 hours)
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    const existing = await prisma.internalUser.findUnique({ where: { email } });
    if (existing)
      return res.status(400).json({ message: "Internal user already exists" });
    const state = await prisma.state.findUnique({
      where: { id: stateId },
      include: {
        approvers: true,
      },
    });
    if (!state) {
      return res.status(401).json({
        message: "State not found",
      });
    }

    if (
      role === "GOVERNOR" &&
      (isNaN(Number(approvingPosition)) || approvingPosition === null)
    ) {
      return res
        .status(400)
        .json({ message: "Governor must have a numeric approving position" });
    }

    if (role === "APPROVER" && approvingPosition) {
      return res
        .status(400)
        .json({ message: "Approver should not have an approving position" });
    }

    if (role === "GOVERNOR" && state.governorId != null) {
        res.status(401).json({
          message: "A Governor has been registered on for that State",
        });
      return;
    }

    const user = await prisma.internalUser.create({
      data: {
        name,
        email,
        phone,
        ministry,
        department,
        approvingPosition:
          role === "GOVERNOR" ? Number(approvingPosition) : null,
        position:
        role === "APPROVER" ? (state.approvers.length ?? 0) + 1 : null,
        function: workflowFunction,
        role: role === "APPROVER" ? "APPROVER" : "GOVERNOR",
        requiresSignature: requiresSignature ?? false,
        signatureUrl,
        stateId: stateId as string,
        isVerified: false,
        emailToken: token,
        tokenExpiresAt: expires,
      },
    });

    if (role === "GOVERNOR")
      await prisma.state.update({
        where: { id: stateId },
        data: {
          governorId: user.id,
        },
      });
    const verifyLink = `https://yourfrontend.com/internal/verify?token=${token}`;
    await sendEmail(
      email,
      "Verify Your Internal Account",
      `<p>Hello ${name},</p>
       <p>You have been registered as a ${role} on the GeoTech platform.</p>
       <p>Verify your email by clicking below (expires in 24 hours):</p>
       <a href="${verifyLink}">${verifyLink}</a>`
    );

    res.status(201).json({ message: "Internal user created", user });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to create internal user", error: err });
  }
};
export const uploadSignature = async (req: any, res: Response) => {
  const userId = req.user.id; // from auth middleware
  const role = req.user.role;

  if (role !== "GOVERNOR") {
    return res
      .status(403)
      .json({ message: "Only governors can upload signatures" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  try {
    const uploaded = await uploadToCloudinary(req.file.path);
    fs.unlinkSync(path.resolve(req.file.path));

    await prisma.internalUser.update({
      where: { id: userId },
      data: { signatureUrl: uploaded.secure_url, requiresSignature: true },
    });

    res.json({
      message: "Signature uploaded successfully",
      signatureUrl: uploaded.secure_url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Signature upload failed", error: err });
  }
};
export const updateSignature = async (req: any, res: Response) => {
  const userId = req.user.id;
  const role = req.user.role;

  if (role !== "GOVERNOR") {
    return res
      .status(403)
      .json({ message: "Only governors can update signature" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "No signature image uploaded" });
  }

  try {
    const uploaded = await uploadToCloudinary(req.file.path);
    fs.unlinkSync(path.resolve(req.file.path));

    const updated = await prisma.internalUser.update({
      where: { id: userId },
      data: {
        signatureUrl: uploaded.secure_url,
        requiresSignature: true,
      },
      select: { id: true, email: true, signatureUrl: true },
    });

    res.json({
      message: "Signature updated successfully",
      signatureUrl: updated.signatureUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update signature", error: err });
  }
};
export const verifyInternalEmail = async (req: Request, res: Response) => {
  const { token } = req.query;

  if (!token) {
    return res
      .status(400)
      .json({ message: "Invalid or expired verification token" });
  }

  try {
    const user = await prisma.internalUser.findFirst({
      where: {
        emailToken: token as string,
        tokenExpiresAt: { gt: new Date() }, // check expiry
      },
    });

    if (!user)
      return res
        .status(400)
        .json({ message: "Invalid or expired verification token" });

    // Mark verified & create password setup token
    const passwordToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 mins to set password

    await prisma.internalUser.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        emailToken: null,
        passwordToken,
        tokenExpiresAt: expires,
      },
    });

    res.json({
      message: "Email verified. Proceed to set your password.",
      passwordToken,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification failed", error: err });
  }
};
export const setInternalUserPassword = async (req: Request, res: Response) => {
  const { token, password } = req.body;

  try {
    const user = await prisma.internalUser.findFirst({
      where: {
        passwordToken: token,
        tokenExpiresAt: { gt: new Date() },
      },
    });

    if (!user)
      return res
        .status(400)
        .json({ message: "Invalid or expired password token" });

    const hash = await bcrypt.hash(password, 10);

    await prisma.internalUser.update({
      where: { id: user.id },
      data: {
        password: hash,
        passwordToken: null,
        tokenExpiresAt: null,
      },
    });

    res.json({ message: "Password set successfully. You can now log in." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to set password", error: err });
  }
};
export const resendInternalVerification = async (
  req: Request,
  res: Response
) => {
  const { email } = req.body;

  try {
    const user = await prisma.internalUser.findUnique({ where: { email } });

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isVerified)
      return res.status(400).json({ message: "User already verified" });

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.internalUser.update({
      where: { id: user.id },
      data: { emailToken: token, tokenExpiresAt: expires },
    });

    const verifyLink = `https://yourfrontend.com/internal/verify?token=${token}`;
    await sendEmail(
      email,
      "Resend Verification - GeoTech",
      `<p>Hello ${user.name},</p>
       <p>Here’s a new verification link for your internal account (expires in 24 hours):</p>
       <a href="${verifyLink}">${verifyLink}</a>`
    );

    res.json({ message: "Verification email resent successfully" });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Failed to resend verification", error: err });
  }
};
export const loginInternalUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Check if user exists
    const user = await prisma.internalUser.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Check if user has verified email
    if (!user.isVerified) {
      return res.status(403).json({
        message:
          "Email not verified. Please check your email to verify your account.",
      });
    }

    // Check if password has been set
    if (!user.password) {
      return res.status(403).json({
        message:
          "You have not set your password yet. Please verify your email and set a password first.",
      });
    }

    // Compare passwords
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: "Invalid credentials" });

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
export const getInternalUserSession = async (req: any, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const user = await prisma.internalUser.findUnique({
      where: { id: userId },
    });
    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
export const refreshInternalToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const internalUser = await prisma.internalUser.findUnique({
      where: { id: userId },
    });
    if (!internalUser)
      return res.status(404).json({ message: "internalUser not found" });
    if (internalUser.role !== "APPROVER" || "GOVERNOR")
      return res
        .status(403)
        .json({ message: "Not authorized as internalUser" });

    const newToken = jwt.sign(
      {
        id: internalUser.id,
        email: internalUser.email,
        role: internalUser.role,
        type: "internalUser",
      },
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
        id: internalUser.id,
        email: internalUser.email,
        name: internalUser.name,
        role: internalUser.role,
      },
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
