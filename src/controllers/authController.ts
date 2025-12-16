import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";
import {
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "../utils/zodSchemas";
import crypto from "crypto";
import { addMinutes } from "date-fns";
import { sendEmail } from "../services/emailSevices";
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
} from "../utils/tokens";
import { clearSessionCookie, setSessionCookie } from "../utils/cookies";

const JWT_SECRET = process.env.JWT_SECRET!;

export const register = async (req: Request, res: Response) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    return res
      .status(400)
      .json({ message: "Validation failed", errors: parse.error.flatten() });
  }

  const { email, password, fullName, phone } = parse.data;
  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser)
      return res.status(400).json({ message: "User already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashed, fullName, phone },
    });
    const token = crypto.randomUUID();
    const expiresAt = addMinutes(new Date(), 30); // valid for 30 mins

    await prisma.emailVerificationToken.create({
      data: { email, token, expiresAt },
    });
    const html = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
    <div style="background: #004CFF; color: #fff; padding: 20px; text-align: center;">
      <h2>GeoTech Account Verification</h2>
    </div>
    <div style="padding: 20px; color: #333;">
      <p>Hi there,</p>
      <p>Thanks for registering with <strong>GeoTech</strong>. To finish setting up your account, please verify your email address.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="http://localhost:5000/auth/verify-email?email=${email}&token=${token}"
           style="background: #004CFF; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Verify My Email
        </a>
      </div>
      <p>If the button above doesn’t work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #004CFF;">http://localhost:5000/auth/verify-email?email=${email}&token=${token}</p>
      <p>This link will expire in <strong>30 minutes</strong>.</p>
    </div>
    <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 12px; color: #888;">
      <p>GeoTech © 2025. All rights reserved.</p>
    </div>
  </div>
`;

    await sendEmail(email, "Verify Your GeoTech Account", html);
    res.status(201).json({
      message: "User registered successfully. Please verify your email.",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

export const login = async (req: Request, res: Response) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    return res
      .status(400)
      .json({ message: "Validation failed", errors: parse.error.flatten() });
  }

  const { email, password } = parse.data;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    if (!user.isEmailVerified)
      return res.status(403).json({ message: "Email not verified" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "Invalid credentials" });

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    await prisma.session.create({
      data: {
        userId: user.id,
        userType: "CITIZEN",
        refreshTokenHash,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    setSessionCookie(res, refreshToken);
    const accessToken = generateAccessToken({
      sub: user.id,
      role: user.role,
    });

    return res.json({
      message: "Login successful",
      accessToken,
      user: {
        id: user.id,
        name: user.fullName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
export const verifyEmail = async (req: Request, res: Response) => {
  const parse = verifyEmailSchema.safeParse(req.body);
  if (!parse.success)
    return res.status(400).json({ errors: parse.error.flatten() });

  const { email, token } = parse.data;

  try {
    const record = await prisma.emailVerificationToken.findUnique({
      where: { token },
    });
    if (!record || record.email !== email) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    if (record.expiresAt < new Date()) {
      return res.status(400).json({ message: "Token has expired" });
    }

    await prisma.user.update({
      where: { email },
      data: { isEmailVerified: true },
    });

    await prisma.emailVerificationToken.delete({ where: { token } });

    res.json({ message: "Email verified successfully" });
  } catch (err) {
    res.status(500).json({ message: "Verification failed", error: err });
  }
};
export const requestPasswordReset = async (req: Request, res: Response) => {
  const parse = requestPasswordResetSchema.safeParse(req.body);
  if (!parse.success)
    return res.status(400).json({ errors: parse.error.flatten() });

  const { email } = parse.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const token = crypto.randomUUID();
    const expiresAt = addMinutes(new Date(), 30);

    await prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    });
    const html = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
    <div style="background: #E63946; color: #fff; padding: 20px; text-align: center;">
      <h2>Password Reset Request</h2>
    </div>
    <div style="padding: 20px; color: #333;">
      <p>Hello,</p>
      <p>We received a request to reset your password for your <strong>GeoTech</strong> account. If this was you, please click the button below to set a new password.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="http://localhost:5000/auth/reset-password?token=${token}"
           style="background: #E63946; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Reset My Password
        </a>
      </div>
      <p>If you didn’t request this, you can safely ignore this email.</p>
      <p>This link will expire in <strong>30 minutes</strong>.</p>
    </div>
    <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 12px; color: #888;">
      <p>GeoTech © 2025. All rights reserved.</p>
    </div>
  </div>
`;

    await sendEmail(email, "Resend Verification - GeoTech Account", html);

    res.json({ message: "Password reset link sent to email" });
  } catch (err) {
    res.status(500).json({ message: "Request failed", error: err });
  }
};

// 📌 Reset Password
export const resetPassword = async (req: Request, res: Response) => {
  const parse = resetPasswordSchema.safeParse(req.body);
  if (!parse.success)
    return res.status(400).json({ errors: parse.error.flatten() });

  const { token, newPassword } = parse.data;

  try {
    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { token },
    });
    if (!resetRecord || resetRecord.expiresAt < new Date()) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: resetRecord.userId },
      data: { password: hashed },
    });

    await prisma.passwordResetToken.delete({ where: { token } });

    res.json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ message: "Reset failed", error: err });
  }
};
export const logout = async (req: Request, res: Response) => {
  const token = req.cookies.geo_session;
  if (token) {
    await prisma.session.updateMany({
      where: { refreshTokenHash: hashToken(token) },
      data: { revoked: true },
    });
  }

  clearSessionCookie(res);
  res.json({ message: "Logged out securely" });
};


export const getAllState = async (req: Request, res: Response) => {
  try {
    const state = await prisma.state.findMany({
      orderBy: {
        name: "asc",
      },
    });
    return res.status(201).json({ message: "State gotten", state });
  } catch (error) {
    console.log(error);
    return res.status(401).json({ success: false, message: "Error occured" });
  }
};
export const refresh = async (req: Request, res: Response) => {
  const token = req.cookies.geo_session;
  if (!token)
    return res.status(401).json({ message: "No session" });

  const hash = hashToken(token);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
  });

  if (!session || session.revoked || session.expiresAt < new Date())
    return res.status(401).json({ message: "Session expired" });

  const accessToken = generateAccessToken({
    sub: session.userId,
    type: session.userType,
  });

  res.json({ accessToken });
};
