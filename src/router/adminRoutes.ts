import express from 'express';
import { getAllApplications, updateApplicationStatus } from '../controllers/adminController';
const router = express.Router();

router.get('/applications', getAllApplications);
router.patch('/applications/:id/status', updateApplicationStatus);

export default router;