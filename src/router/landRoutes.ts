import express from 'express';
import multer from 'multer';
import { registerLand } from '../controllers/landController';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/', upload.array('documents'), registerLand);

export default router;