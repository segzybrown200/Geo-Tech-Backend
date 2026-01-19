import express from 'express';
import multer from 'multer';
import { applyForCofO, resubmitCofO, reviewCofO } from '../controllers/cofoController';
import { requireAuth, verifyToken } from '../middlewares/authMiddleware';
import { initializePayment, verifyPayment } from '../controllers/paymentController';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/apply/:cofOApplicationId', upload.array('documents'), requireAuth, applyForCofO);
router.post('/review/:id', reviewCofO); // :id = CofOApplication.id
router.post("/init", verifyToken, initializePayment);
router.get("/verify", verifyPayment);
router.post("/re-submit/:cofOId", requireAuth, upload.array('documents'), resubmitCofO);
export default router;
