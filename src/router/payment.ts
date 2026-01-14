import express from 'express';



import { initializePayment, verifyPayment } from '../controllers/paymentController';

import { verifyToken } from '../middlewares/authMiddleware';
const router = express.Router();

router.post('/initialize', verifyToken, initializePayment);
router.get('/verify', verifyPayment);
export default router;