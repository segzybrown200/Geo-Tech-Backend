import express from "express";
import {
  createInternalUser,
  getCofOActivityLogs,
  getCofOForReview,
  getDashboardStats,
  getInternalUserSession,
  getReviewerApplications,
  loginInternalUser,
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

router.get("/dashboard", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), getDashboardStats);
router.get("/activity", internalUserAuth,  authorizeRoles(["GOVERNOR", "APPROVER"]),getCofOActivityLogs);
router.get("/reviewer/applications", internalUserAuth,  authorizeRoles(["GOVERNOR", "APPROVER"]),getReviewerApplications);
router.get("/review/:id", internalUserAuth, authorizeRoles(["GOVERNOR", "APPROVER"]), getCofOForReview);


export default router;
