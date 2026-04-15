// src/routes/ownershipRoutes.ts
import express, { Request, Response } from "express";
import { internalUserAuth, requireAuth, verifyToken } from "../middlewares/authMiddleware";
import {
  initiateOwnershipTransfer,
  verifyTransfer,
  reviewTransfer,
  getTransfersForReview,
  getUserOwnershipTransfers,
  rejectOwnershipTransfer,
  approveOwnershipTransfer,
  getUserTransfers,
  approveDocument,
  rejectDocument,
  getTransferForReview,
  getTransferDetails,
  resendTransferOTP,
  uploadTransferDocuments,
} from "../controllers/ownershipController";
import { authorizeRoles } from "../middlewares/roleMiddleware";
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
router.get("/:transferId/progress", requireAuth, getUserTransfers);

// Resend transfer OTP
router.post("/:transferId/resend-otp", requireAuth, resendTransferOTP);

// Upload transfer documents
router.post("/:transferId/upload-documents", requireAuth, upload.array("documents"), uploadTransferDocuments);

/* ========================
   APPROVER/GOVERNOR ENDPOINTS
   ======================== */

// Get transfers for review
router.get("/for-review", internalUserAuth, authorizeRoles(["APPROVER", "GOVERNOR"]), getTransfersForReview);

// Review transfer (approve/reject/forward)
router.post("/:transferId/review", internalUserAuth, authorizeRoles(["APPROVER", "GOVERNOR"]), reviewTransfer);
router.get(
  "/governor/review/:transferId",
  internalUserAuth,
  authorizeRoles(["GOVERNOR"]),
  getTransferForReview
);

// Approve transfer
router.post(
  "/:transferId/approve",
  internalUserAuth,
  authorizeRoles(["GOVERNOR"]),
  approveOwnershipTransfer
);

// Reject transfer with reason
router.post(
  "/:transferId/reject",
  internalUserAuth,
  authorizeRoles(["GOVERNOR"]),
  rejectOwnershipTransfer
);

/* ========================
   DOCUMENT-LEVEL ENDPOINTS
   ======================== */

// Approve individual document
router.post(
  "/document/:documentId/approve",
  internalUserAuth,
  authorizeRoles(["APPROVER", "GOVERNOR"]),
  approveDocument
);

// Reject individual document
router.post(
  "/document/:documentId/reject",
  internalUserAuth,
  authorizeRoles(["APPROVER", "GOVERNOR"]),
  rejectDocument
);

export default router;
