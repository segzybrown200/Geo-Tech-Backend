// src/utils/zodSchemas.ts
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(2),
});

export const transferOwnershipSchema = z.object({
  landId: z.string().uuid(),
  newOwnerEmail: z.string().email(),
});

export const landRegistrationSchema = z.object({
  ownerName: z.string().min(3),
  latitude: z.string().transform(Number),
  longitude: z.string().transform(Number),
  squareMeters: z.string().transform(Number),
  ownershipType: z.string(),
  purpose: z.string(),
  titleType: z.string(),
  stateId: z.string().uuid(),
});

export const internalUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  ministry: z.string(),
  department: z.string(),
  position: z.string().optional(),
  function: z.string(),
  role: z.string(),
  requiresSignature: z.boolean().optional(),
  signatureUrl: z.string().url().optional(),
  stateId: z.string().uuid(),
});

export const cofoApplySchema = z.object({
  landId: z.string().uuid(),
});
export const loginSchema = z.object({
  username: z.string(),
  password: z.string().min(6),
});

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(6),
  newPassword: z.string().min(6),
});

export const verifyEmailSchema = z.object({
  email: z.string().email(),
  token: z.string(), // could be UUID or random string
});
export const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(6),
});

export const cofoReviewSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),   // action by reviewer
  message: z.string().optional(),          // optional comment when rejecting or note
  signatureUrl: z.string().url().optional() // optional signature image URL if required
});
export const cofoBatchSignSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  signatureUrl: z.string().url()
});