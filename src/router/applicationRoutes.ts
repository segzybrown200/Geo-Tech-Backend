import express from 'express';
import multer from 'multer';
import { submitApplication } from '../controllers/applicationController';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/', upload.single('document'), submitApplication);

export default router;