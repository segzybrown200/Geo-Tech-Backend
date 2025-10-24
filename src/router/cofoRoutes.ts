import express from 'express';
import multer from 'multer';
import { applyForCofO, reviewCofO } from '../controllers/cofoController';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/apply', upload.array('documents'), applyForCofO);
router.post('/review/:id', reviewCofO); // :id = CofOApplication.id

export default router;
