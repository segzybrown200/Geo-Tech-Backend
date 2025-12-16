import express from 'express';
import multer from 'multer';
import { registerLand } from '../controllers/landController';
import { requireAuth } from '../middlewares/authMiddleware';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/', upload.array('documents'), requireAuth, registerLand);

export default router;