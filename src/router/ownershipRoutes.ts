// src/routes/ownershipRoutes.ts
import express, { Request, Response } from "express";
import { internalUserAuth, requireAuth, verifyToken } from "../middlewares/authMiddleware";
import {
  initiateOwnershipTransfer,
  verifyTransfer,
  getUserOwnershipTransfers,
  getUserTransfers,
  getTransferProgress,
  getTransferDetails,
  resendTransferOTP,
  uploadTransferDocuments,
  requestTransferActionConsent,
  verifyTransferActionRequest,
  rejectTransferActionRequest,
  getTransferActionRequest,
} from "../controllers/ownershipController";

import multer from "multer";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/* ========================
   USER ENDPOINTS (Citizens)
   ======================== */

// Initiate ownership transfer
router.post("/initiate", requireAuth, initiateOwnershipTransfer);

// Verify transfer
router.post("/verify", requireAuth, verifyTransfer);

// Get user's transfers
router.get("/my-transfers", requireAuth, getUserTransfers);

// Get user's ownership transfers (alternative endpoint)
router.get("/user-transfers", requireAuth, getUserOwnershipTransfers);

// Get transfer details by ID
router.get("/:transferId/details", requireAuth, getTransferDetails);

// Get transfer progress/status
router.get("/:transferId/progress", requireAuth, getTransferProgress);

// Resend transfer OTP
router.post("/:transferId/resend-otp", requireAuth, resendTransferOTP);
router.post("/transfer-action-request", requireAuth, requestTransferActionConsent);
router.get("/transfer-action-request/:requestId", requireAuth, getTransferActionRequest);
router.post("/transfer-action-request/:requestId/verify", requireAuth, verifyTransferActionRequest);
router.post("/transfer-action-request/:requestId/reject", requireAuth, rejectTransferActionRequest);

// Upload transfer documents
router.post("/:transferId/upload-documents", requireAuth, upload.array("documents"), uploadTransferDocuments);

/* ========================
   GOVERNOR ENDPOINTS
   ======================== */



export default router;
