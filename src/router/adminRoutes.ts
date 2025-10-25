import express from 'express';
import { createFirstAdmin, getAllActivities, getAllApplications, getAllInternalUser, getAllUser, getAnalytics, getPayments, loginAdmin, refreshAdminToken, updateApplicationStatus } from '../controllers/adminController';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import { verifyToken } from '../middlewares/authMiddleware';
const router = express.Router();

router.get('/applications', getAllApplications);
router.patch('/applications/:id/status', updateApplicationStatus);
router.post("/create-admin",verifyToken, authorizeRoles(['ADMIN']), createFirstAdmin);
router.post("/admin-login", loginAdmin);
router.get("/refresh", verifyToken, refreshAdminToken)
router.get("/get-payments", verifyToken, authorizeRoles(['ADMIN']), getPayments)
router.get("/get-activties", verifyToken, authorizeRoles(['ADMIN']), getAllActivities)
router.get("/get-Analytics", verifyToken, authorizeRoles(['ADMIN']), getAnalytics)
router.get("/get-all-internal-user", verifyToken, authorizeRoles(['ADMIN']), getAllInternalUser)
router.get("/get-all-user", verifyToken, authorizeRoles(['ADMIN']), getAllUser)


export default router;