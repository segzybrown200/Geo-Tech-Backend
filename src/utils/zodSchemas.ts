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
  surveyType: z.enum(["COORDINATE", "BEARING"]),
  coordinates: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, z.array(z.tuple([z.number(), z.number()])).optional()),
  bearings: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, z.array(
    z.object({
      distance: z.number().positive(),
      bearing: z.number().min(0).max(360),
    })
  ).optional()),
  startPoint: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, z.tuple([z.number(), z.number()]).optional()),
  utmZone: z.string().min(2).optional(),
  stateId: z.string().uuid().optional(),
}).superRefine((data, ctx) => {
  if (data.surveyType === "COORDINATE") {
    if (!data.coordinates || data.coordinates.length < 4) {
      ctx.addIssue({
        path: ["coordinates"],
        code: z.ZodIssueCode.custom,
        message: "A valid coordinate polygon must have at least 4 points",
      });
      return;
    }

    const first = data.coordinates[0];
    const last = data.coordinates[data.coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ctx.addIssue({
        path: ["coordinates"],
        code: z.ZodIssueCode.custom,
        message: "Polygon must be closed",
      });
    }
  } else {
    if (!data.bearings || data.bearings.length < 3) {
      ctx.addIssue({
        path: ["bearings"],
        code: z.ZodIssueCode.custom,
        message: "At least 3 bearings are required for a bearing survey",
      });
    }
    if (!data.startPoint) {
      ctx.addIssue({
        path: ["startPoint"],
        code: z.ZodIssueCode.custom,
        message: "Start point is required for bearing verification",
      });
    }
    if (!data.utmZone) {
      ctx.addIssue({
        path: ["utmZone"],
        code: z.ZodIssueCode.custom,
        message: "UTM zone is required for bearing verification",
      });
    }
  }
});


export const landRegistrationSchema = z.object({
  ownerName: z.string().min(3),
  ownershipType: z.string(),
  purpose: z.string(),
  titleType: z.string(),

  stateId: z.string().uuid(),
  address: z.string().min(5).optional(),
  plotNumber: z.string().min(1).optional(),

  // 🔥 Survey type: how the land is being recorded
  surveyType: z.enum(["COORDINATE", "BEARING"]),

  // 🔥 Polygon coordinates for COORDINATE survey
  coordinates: z
    .preprocess((val) => {
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
      z.tuple([z.number(), z.number()]) // [lat, lng]
    ).min(4, "A valid land polygon must have at least 4 points")
  ).optional(),

  // 🔥 Bearings for BEARING survey
  bearings: z.preprocess((val) => {
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
  z.object({
    distance: z.number(),
    bearing: z.number(),
  })
)
  .min(3, "At least 3 bearings required for a bearing survey")
.optional()),
startPoint: z.preprocess((val) => {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}
,
z.tuple([z.number(), z.number()]) // [lat, lng]
.optional()),
  // bearings: z
  //   .array(
  //     z.object({
  //       distance: z.number().positive(),
  //       bearing: z.number().min(0).max(360),
  //     })
  //   )
  //   .min(3, "At least 3 bearings required for a bearing survey")
  //   .optional(),

  utmZone: z.string().min(2, "UTM zone is required for conversion").optional(),

  surveyPlanNumber: z.string().min(3),
  surveyDate: z.string().optional(),
  surveyorName: z.string().min(3),
  surveyorAddress: z.string().optional(),
  surveyTelephone: z.string().optional(),
  surveyNotes: z.string().optional(),
  accuracyLevel: z.enum(["SURVEYED", "SATELLITE", "USER_DRAWN"]),
  measuredAreaSqm: z.preprocess((val) => {
    if (typeof val === "string") {
      const parsed = Number(val.trim());
      return Number.isNaN(parsed) ? val : parsed;
    }
    return val;
  }, z.number().positive("Area must be greater than 0").optional()),

  parentLandId: z.string().uuid().optional(),

  // 📄 Existing C of O Fields
  hasExistingCofO: z.boolean().default(false),
  existingCofONumber: z.string().optional(),
  existingCofOIssueDate: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.surveyType === "COORDINATE") {
    if (!data.coordinates || data.coordinates.length < 4) {
      ctx.addIssue({
        path: ["coordinates"],
        code: z.ZodIssueCode.custom,
        message: "A valid land polygon must have at least 4 points",
      });
    }
  } else {
    if (!data.bearings || data.bearings.length < 3) {
      ctx.addIssue({
        path: ["bearings"],
        code: z.ZodIssueCode.custom,
        message: "At least 3 bearings are required for a bearing survey",
      });
    }
    if (!data.startPoint) {
      ctx.addIssue({
        path: ["startPoint"],
        code: z.ZodIssueCode.custom,
        message: "Start point is required for bearing surveys",
      });
    }
    if (!data.utmZone) {
      ctx.addIssue({
        path: ["utmZone"],
        code: z.ZodIssueCode.custom,
        message: "UTM zone is required for bearing surveys",
      });
    }
  }

  if (data.hasExistingCofO) {
    if (!data.existingCofONumber) {
      ctx.addIssue({
        path: ["existingCofONumber"],
        code: z.ZodIssueCode.custom,
        message: "Existing CofO number is required when you already have an existing CofO",
      });
    }
    if (!data.existingCofOIssueDate) {
      ctx.addIssue({
        path: ["existingCofOIssueDate"],
        code: z.ZodIssueCode.custom,
        message: "Existing CofO issue date is required when you already have an existing CofO",
      });
    } else if (isNaN(Date.parse(data.existingCofOIssueDate))) {
      ctx.addIssue({
        path: ["existingCofOIssueDate"],
        code: z.ZodIssueCode.custom,
        message: "Existing CofO issue date must be a valid date",
      });
    }
  }
});

export const landRegistrationWithPaymentSchema = landRegistrationSchema.safeExtend({
  paymentReference: z.string().min(3, "Payment reference is required"),
  paymentAmount: z.preprocess((val) => {
    if (typeof val === "string") {
      const parsed = Number(val.trim());
      return Number.isNaN(parsed) ? val : parsed;
    }
    return val;
  }, z.number().positive("Payment amount must be greater than 0")),
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

// Ownership Transfer Schemas
export const ownershipTransferInitiateSchema = z.object({
  landId: z.string().uuid(),
  newOwnerEmail: z.string().email(),
  newOwnerPhone: z.string().optional(),
  transferType: z.enum(["FULL", "PARTIAL"]),
  transferSurveyType: z.enum(["COORDINATE", "BEARING"]).optional(),
  coordinates: z.array(z.tuple([z.number(), z.number()])).optional(), // [lat, lng][]
  bearings: z.array(z.object({
    distance: z.number().positive(),
    bearing: z.number().min(0).max(360)
  })).optional(),
  startPoint: z.tuple([z.number(), z.number()]).optional(), // [lat, lng]
  utmZone: z.string().optional(),
  measuredAreaSqm: z.preprocess((val) => typeof val === 'string' ? parseFloat(val) : val, z.number().positive().optional()),
});

export const ownershipTransferVerifySchema = z.object({
  transferId: z.string().uuid(),
  code: z.string(),
});

export const ownershipTransferReviewSchema = z.object({
  transferId: z.string().uuid(),
  action: z.enum(["APPROVE", "REJECT", "FORWARD"]),
  message: z.string().optional(),
});

export const ownershipTransferDocumentUploadSchema = z.object({
  documentsMeta: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, z.array(z.object({
    type: z.enum([
      "TRANSFER_AGREEMENT",
      "ID_DOCUMENT_CURRENT_OWNER",
      "ID_DOCUMENT_NEW_OWNER",
      "PAYMENT_RECEIPT",
      "SURVEY_DOCUMENT",
      "SUBDIVISION_AGREEMENT",
      "UPDATED_TITLE_DOCUMENT",
      "OTHER"
    ]),
    title: z.string().min(1),
  }))),
});

// Land Conflict & Payment Schemas
export const acknowledgeLandConflictSchema = z.object({
  conflictId: z.string().uuid(),
  acknowledged: z.boolean(),
});

export const paymentConfirmationSchema = z.object({
  paymentId: z.string().uuid(),
  status: z.enum(["SUCCESS", "FAILED", "UNPAID"]),
  transactionReference: z.string().optional(),
});

export const existingCofOUploadSchema = z.object({
  cofONumber: z.string().min(3, "C of O number is required"),
  issueDate: z.string().optional(),
  hasExistingCofO: z.boolean().default(true),
});