// src/routes/ownershipRoutes.ts
import express, { Request, Response } from "express";
import { internalUserAuth, requireAuth, verifyToken } from "../middlewares/authMiddleware";
import {
  initiateOwnershipTransfer,
  verifyTransferOTP,
  submitTransferDocuments,
  approveOwnershipTransfer,
  rejectOwnershipTransfer,
  getTransferForReview,
  getTransferProgress,
  listTransfersForGovernor,
  getUserOwnershipTransfers,
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

// Verify OTP from all parties
router.post("/verify-otp", requireAuth, verifyTransferOTP);

// Submit documents for governor review
router.post(
  "/:transferId/submit-documents",
  requireAuth,
  upload.array("documents"),
  submitTransferDocuments
);

router.get("/user-transfer-list", requireAuth, getUserOwnershipTransfers);

// Get transfer progress and status
router.get("/:transferId/progress", requireAuth, getTransferProgress);

/* ========================
   GOVERNOR ENDPOINTS
   ======================== */

// List all transfers pending review
router.get("/governor/list", internalUserAuth, authorizeRoles(["GOVERNOR"]), listTransfersForGovernor);

// Get transfer details for review
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

export default router;
