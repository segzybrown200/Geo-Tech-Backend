import express from "express";
import {
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
const upload = multer({ dest: "uploads/" });

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
router.get("/monthly-trends", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), getCofOMonthlyTrends);
router.get("/inbox/my-tasks", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), getMyInboxTasks);
router.post("/inbox/:id/complete", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), completeInboxTask);

export default router;
