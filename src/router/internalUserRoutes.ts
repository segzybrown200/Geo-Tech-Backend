import express from "express";
import {
  approveDocumentForCofO,
  completeInboxTask,
  createInternalUser,
  getCofOActivityLogs,
  getCofOForReview,
  getCofOMonthlyTrends,
  getDashboardStatsForGovernor,
  getDashboardStatsForReviwer,
  getInternalUserSession,
  getMyInboxTasks,
  getReviewerApplications,
  governorApproverPerformance,
  governorInboxBacklog,
  governorLocationReport,
  governorProcessingTimeReport,
  governorReviewerPerformance,
  governorStageDelayReport,
  governorStatusReport,
  governorTrendReport,
  loginInternalUser,
  logoutInternalUser,
  refreshInternalToken,
  resendInternalVerification,
  setInternalUserPassword,
  updateSignature,
  uploadSignature,
  verifyInternalEmail,
} from "../controllers/internalUserController";
import {
  internalUserAuth,
  AdminverifyToken,
} from "../middlewares/authMiddleware";
import { authorizeRoles } from "../middlewares/roleMiddleware";
import multer from "multer";
import { approveDocument, approveOwnershipTransfer, getTransferForReview, getTransfersForReview, listTransfersForGovernor, rejectDocument, rejectOwnershipTransfer, reviewTransfer } from "../controllers/ownershipController";
import { getLandForReview, reviewLand } from "../controllers/landController";
const upload = multer({ storage: multer.memoryStorage() });

const router = express.Router();

router.post(
  "/",
  AdminverifyToken,
  authorizeRoles(["ADMIN"]),
  createInternalUser,
);
router.post(
  "/upload-signature",
  AdminverifyToken,
  authorizeRoles(["GOVERNOR"]),
  upload.single("signature"),
  uploadSignature,
);
router.patch(
  "/update-signature",
  AdminverifyToken,
  authorizeRoles(["GOVERNOR"]),
  upload.single("signature"),
  updateSignature,
);
router.get("/verify", verifyInternalEmail);
router.post("/set-password", setInternalUserPassword);
router.post("/resend-verification", resendInternalVerification);
router.post("/login", loginInternalUser);
router.get("/session", internalUserAuth, getInternalUserSession);
router.get("/refresh", AdminverifyToken, refreshInternalToken);
router.get("/logout", logoutInternalUser);
router.get(
  "/dashboard",
  internalUserAuth,
  authorizeRoles([ "APPROVER"]),
  getDashboardStatsForReviwer,
);
router.get(
  "/dashboard/governor",
  internalUserAuth, authorizeRoles([ "GOVERNOR"]), getDashboardStatsForGovernor)
router.get(
  "/activity",
  internalUserAuth,
  authorizeRoles(["GOVERNOR", "APPROVER"]),
  getCofOActivityLogs,
);
router.get(
  "/reviewer/applications",
  internalUserAuth,
  authorizeRoles(["GOVERNOR", "APPROVER"]),
  getReviewerApplications,
);
router.get(
  "/review/:id",
  internalUserAuth,
  authorizeRoles(["GOVERNOR", "APPROVER"]),
  getCofOForReview,
);
router.get(
  "/land-review/:id",
  internalUserAuth,
  authorizeRoles(["APPROVER"]),
  getLandForReview,
);
router.post(
  "/land-review/:id",
  internalUserAuth,
  authorizeRoles(["APPROVER"]),
  reviewLand,
);
router.post("/approve-document/:documentId", internalUserAuth, approveDocumentForCofO)
router.get("/monthly-trends", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), getCofOMonthlyTrends);
router.get("/inbox/my-tasks", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), getMyInboxTasks);
router.post("/inbox/:id/complete", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), completeInboxTask);
router.get("/governor/reports/approver-performance", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorApproverPerformance);

router.get("/governor/reports/stage-delays", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorStageDelayReport);

router.get("/governor/reports/inbox-backlog", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorInboxBacklog);
router.get("/reports/status", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorStatusReport);
router.get("/reports/processing-time", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorProcessingTimeReport);
router.get("/reports/location", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorLocationReport);
router.get("/reports/trends", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorTrendReport);
router.get("/reports/reviewer-performance", internalUserAuth, authorizeRoles(["GOVERNOR"]), governorReviewerPerformance);


/* ========================
   APPROVER/GOVERNOR ENDPOINTS
   ======================== */

// Get transfers for review
router.get("/for-review", internalUserAuth, authorizeRoles(["APPROVER", "GOVERNOR"]), getTransfersForReview);

// Get single transfer for review (for approvers and governors)
router.get("/:transferId/review", internalUserAuth, authorizeRoles(["APPROVER", "GOVERNOR"]), getTransferForReview);

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
// List transfers for governor
router.get("/governor/list", internalUserAuth, listTransfersForGovernor);


export default router;
