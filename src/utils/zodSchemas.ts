// src/utils/zodSchemas.ts
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(2),
  phone: z.string().min(7),
});

export const transferOwnershipSchema = z.object({
  landId: z.string().uuid(),
  newOwnerEmail: z.string().email(),
});
export const landVerificationSchema = z.object({
  coordinates: z.array(
    z.tuple([z.number(), z.number()])
  ).min(4),

  stateId: z.string().uuid().optional(),
}).refine((data) => {
  const first = data.coordinates[0];
  const last = data.coordinates[data.coordinates.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}, {
  message: "Polygon must be closed",
});

export const landRegistrationSchema = z.object({
  ownerName: z.string().min(3),

  ownershipType: z.string(),
  purpose: z.string(),
  titleType: z.string(),

  stateId: z.string().uuid(),
  address: z.string().min(5).optional(),

  // 🔥 NEW: polygon coordinates
  coordinates: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  },
  z.array(
    z.tuple([
      z.number(),
      z.number(),
    ])
  ).min(4, "A valid land polygon must have at least 4 points")
  ),

  surveyPlanNumber: z.string().min(3),
  surveyDate: z.string().optional(),
  surveyorName: z.string().min(3),
  surveyorLicense: z.string().optional(),
  accuracyLevel: z.enum(["SURVEYED", "SATELLITE", "USER_DRAWN"]),

  parentLandId: z.string().uuid().optional(),
});

export const internalUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  ministry: z.string(),
  department: z.string(),
  position: z.string().optional(),
  approvingPosition: z.number().optional(),
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
   email: z.string().email(),
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