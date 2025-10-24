// src/routes/ownershipRoutes.ts
import express from "express";
import { verifyToken } from "../middlewares/authMiddleware";
import {
  initiateTransfer,
  verifyTransferCode,
  finalizeTransfer,
} from "../controllers/ownershipController";

const router = express.Router();

router.post("/initiate", verifyToken, initiateTransfer);
router.post("/verify", verifyToken, verifyTransferCode);
router.post("/finalize", verifyToken, finalizeTransfer);

export default router;
