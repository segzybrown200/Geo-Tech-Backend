import { Request, Response } from "express";
import bcrypt from "bcryptjs";

import {
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "../utils/zodSchemas";
import crypto from "crypto";
import { addMinutes } from "date-fns";
import { sendEmail } from "../services/emailSevices";
import prisma from "../lib/prisma";
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
} from "../utils/tokens";
import { clearSessionCookie, setSessionCookie } from "../utils/cookies";

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
  <div style="font-family: Arial, sans-serif; max-width: 680px; margin: auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
    <div style="background: #004CFF; color: #fff; padding: 24px; text-align: center;">
      <h2>GeoTech Account Verification — Action Required</h2>
    </div>
    <div style="padding: 22px; color: #222; line-height: 1.5;">
      <p>Dear Applicant,</p>
      <p>Thank you for registering an account with GeoTech. To ensure the security and proper activation of your account, please confirm your email address by following the verification link below. This verifies that you have access to the email address provided and completes the first step of the registration process.</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="http://localhost:5173/auth/verify-email?email=${email}&token=${token}"
           style="background: #004CFF; color: #fff; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
          Verify Your Email Address
        </a>
      </div>
      <p>If you are unable to click the button, please copy and paste the following URL into your web browser to complete verification:</p>
      <p style="word-break: break-all; color: #004CFF;">http://localhost:5173/auth/verify-email?email=${email}&token=${token}</p>
      <p>Please note: this verification link will expire in <strong>30 minutes</strong>. If the link expires, you may request a new verification email through your account registration flow.</p>
      <p>If you did not initiate this registration, please disregard this message or contact our support team immediately so we may investigate.</p>
      <p>Kind regards,<br/>The GeoTech Team</p>
    </div>
    <div style="background: #f7f7f7; padding: 14px 18px; text-align: center; font-size: 12px; color: #666;">
      <p>GeoTech — Secure Land & Property Registry. For assistance, contact support@geotech.example (replace with actual support address).</p>
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
  const parse = loginSchema.safeParse(req.body);
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
    
    // Delete existing sessions for this user
    await prisma.session.deleteMany({
      where: { userId: user.id },
    });
    
    // Create new session
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
    const user = await prisma.user.findUnique({
      where: { email },
      select: { isEmailVerified: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ message: "Email already verified" });
    }
    const record = await prisma.emailVerificationToken.findFirst({
      where: { token },
    });

    if (!record) {
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
    console.log(err)
    res.status(500).json({ message: "Verification failed", error: err });
  }
};

export const resendVerification = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isEmailVerified)
      return res.status(400).json({ message: "User already verified" });

    // rate-limit: prevent resending more than once per 60 seconds
    const recent = await prisma.emailVerificationToken.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });
    if (
      recent &&
      recent.createdAt &&
      new Date().getTime() - new Date(recent.createdAt).getTime() < 60 * 1000
    ) {
      return res
        .status(429)
        .json({ message: "Please wait before requesting another code" });
    }

    // remove previous tokens for this email
    await prisma.emailVerificationToken.deleteMany({ where: { email } });

    const token = crypto.randomUUID();
    const expiresAt = addMinutes(new Date(), 30);

    await prisma.emailVerificationToken.create({
      data: { email, token, expiresAt },
    });

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 680px; margin: auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
        <div style="background: #004CFF; color: #fff; padding: 20px; text-align: center;">
          <h2>GeoTech Account Verification — Resent Link</h2>
        </div>
        <div style="padding: 20px; color: #222; line-height: 1.5;">
          <p>Dear Applicant,</p>
          <p>We received a request to resend the email verification link associated with your GeoTech account. To complete account activation, please follow the verification link below at your earliest convenience.</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="http://localhost:5173/auth/verify-email?email=${email}&token=${token}"
               style="background: #004CFF; color: #fff; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
              Verify Your Email Address
            </a>
          </div>
          <p>If you cannot use the button, copy and paste this URL into your browser:</p>
          <p style="word-break: break-all; color: #004CFF;">http://localhost:5173/auth/verify-email?email=${email}&token=${token}</p>
          <p>This link will expire in <strong>30 minutes</strong>. If you continue to have trouble, contact our support team for assistance.</p>
          <p>Sincerely,<br/>GeoTech Support</p>
        </div>
        <div style="background: #f7f7f7; padding: 14px 18px; text-align: center; font-size: 12px; color: #666;">
          <p>GeoTech — Secure Land & Property Registry. For assistance, contact support@geotech.example.</p>
        </div>
      </div>
    `;

    await sendEmail(email, "Resend Verification - GeoTech Account", html);

    res.json({ message: "Verification email resent" });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Failed to resend verification", error: err });
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
  <div style="font-family: Arial, sans-serif; max-width: 680px; margin: auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
    <div style="background: #E63946; color: #fff; padding: 22px; text-align: center;">
      <h2>GeoTech — Password Reset Request</h2>
    </div>
    <div style="padding: 20px; color: #222; line-height: 1.5;">
      <p>Dear User,</p>
      <p>We have received a request to reset the password for the GeoTech account associated with this email address. To proceed with resetting your password, please click the button below and follow the instructions on the page.</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="http://localhost:5173/auth/reset-password?token=${token}"
           style="background: #E63946; color: #fff; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
          Reset My Password
        </a>
      </div>
      <p>If you did not request a password reset, please ignore this email. No changes will be made to your account. If you are concerned that your account may be compromised, contact GeoTech Support immediately.</p>
      <p>This password reset link will expire in <strong>30 minutes</strong>. For continued assistance, contact support@geotech.example.</p>
      <p>Respectfully,<br/>GeoTech Security Team</p>
    </div>
    <div style="background: #f7f7f7; padding: 14px 18px; text-align: center; font-size: 12px; color: #666;">
      <p>GeoTech — Secure Land & Property Registry. For assistance, contact support@geotech.example.</p>
    </div>
  </div>
`;

    await sendEmail(email, "Password Reset Request - GeoTech", html);

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
  if (!token) return res.status(401).json({ message: "No session" });

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

  const user = await prisma.user.findUnique({ where: { id: session.userId } });

  if (!user) return res.status(404).json({ message: "User not found" });

  res.json({ accessToken, user: { name: user.fullName, email: user.email, role: user.role } });
};

