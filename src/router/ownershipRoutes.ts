// src/routes/ownershipRoutes.ts
import express from "express";
import { requireAuth, verifyToken } from "../middlewares/authMiddleware";
import {
  initiateTransfer,
  verifyTransferCode,
  finalizeTransfer,
} from "../controllers/ownershipController";

const router = express.Router();

router.post("/initiate", requireAuth, initiateTransfer);
router.post("/verify", requireAuth, verifyTransferCode);
router.post("/finalize", requireAuth, finalizeTransfer);

export default router;
