import express from 'express';
import { createFirstAdmin, getAllApplications, loginAdmin, refreshAdminToken, updateApplicationStatus } from '../controllers/adminController';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import { verifyToken } from '../middlewares/authMiddleware';
const router = express.Router();

router.get('/applications', getAllApplications);
router.patch('/applications/:id/status', updateApplicationStatus);
router.post("/create-admin",verifyToken, authorizeRoles(['ADMIN']), createFirstAdmin);
router.post("/admin-login", loginAdmin);
router.get("/refresh", verifyToken, refreshAdminToken)

export default router;