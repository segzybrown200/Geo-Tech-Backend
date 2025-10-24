// src/routes/ownershipRoutes.ts
import express from 'express';
import { transferOwnership, getOwnershipHistory } from '../controllers/ownershipController';
import { verifyToken } from '../middlewares/authMiddleware';

const router = express.Router();

router.post('/transfer', verifyToken, transferOwnership);
router.get('/history/:landId', verifyToken, getOwnershipHistory);

export default router;
