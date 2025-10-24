import { Request, Response } from 'express';
import { PrismaClient, Role } from '../generated/prisma';
import { internalUserSchema } from '../utils/zodSchemas';
import { uploadToCloudinary } from '../services/uploadService';
import fs from 'fs';
import path from 'path';
import crypto from "crypto";
import { sendEmail } from '../services/emailSevices';
import bcrypt from "bcryptjs"

const prisma = new PrismaClient();

export const createInternalUser = async (req: Request, res: Response) => {

   const body = internalUserSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ message: 'Invalid internal user input', errors: body.error.flatten() });
  }

  const {
    name, email, phone, ministry, department,
    position, function: workflowFunction, role,
    requiresSignature, signatureUrl,stateId
  } = body.data;

      // Generate verification token (expires in 24 hours)
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    const existing = await prisma.internalUser.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: 'Internal user already exists' });

    const user = await prisma.internalUser.create({
      data: {
        name,
        email,
        phone,
        ministry,
        department,
        position,
        function: workflowFunction,
        role: (role && Role[role as keyof typeof Role]) || Role.APPROVER,
        requiresSignature: requiresSignature ?? false,
        signatureUrl,
        stateId: stateId as string ,
        isVerified: false,
        emailToken: token,
        tokenExpiresAt: expires,
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

    res.status(201).json({ message: 'Internal user created', user });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create internal user', error: err });
  }
};
export const uploadSignature = async (req: any, res: Response) => {
  const userId = req.user.id; // from auth middleware
  const role = req.user.role;

  if (role !== 'GOVERNOR') {
    return res.status(403).json({ message: 'Only governors can upload signatures' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    const uploaded = await uploadToCloudinary(req.file.path);
    fs.unlinkSync(path.resolve(req.file.path));

    await prisma.internalUser.update({
      where: { id: userId },
      data: { signatureUrl: uploaded.secure_url, requiresSignature: true }
    });

    res.json({ message: 'Signature uploaded successfully', signatureUrl: uploaded.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Signature upload failed', error: err });
  }
};
export const updateSignature = async (req: any, res: Response) => {
  const userId = req.user.id;
  const role = req.user.role;

  if (role !== 'GOVERNOR') {
    return res.status(403).json({ message: 'Only governors can update signature' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'No signature image uploaded' });
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

    res.json({ message: 'Signature updated successfully', signatureUrl: updated.signatureUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update signature', error: err });
  }
};
export const verifyInternalEmail = async (req:Request, res:Response) => {
  const { token } = req.query;

  if(!token){
      return res.status(400).json({ message: "Invalid or expired verification token" });
  }

  try {
    const user = await prisma.internalUser.findFirst({
      where: {
        emailToken: token as string,
        tokenExpiresAt: { gt: new Date() }, // check expiry
      },
    });

    if (!user)
      return res.status(400).json({ message: "Invalid or expired verification token" });

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
export const setInternalUserPassword = async (req:Request, res:Response) => {
  const { token, password } = req.body;

  try {
    const user = await prisma.internalUser.findFirst({
      where: {
        passwordToken: token,
        tokenExpiresAt: { gt: new Date() },
      },
    });

    if (!user)
      return res.status(400).json({ message: "Invalid or expired password token" });

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
export const resendInternalVerification = async (req:Request, res:Response) => {
  const { email } = req.body;

  try {
    const user = await prisma.internalUser.findUnique({ where: { email } });

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isVerified) return res.status(400).json({ message: "User already verified" });

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
    res.status(500).json({ message: "Failed to resend verification", error: err });
  }
};