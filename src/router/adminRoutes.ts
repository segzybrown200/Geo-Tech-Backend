import express from 'express';
import { createFirstAdmin, getAllActivities, getAllApplications, getAllInternalUser, getAllUser, getAnalytics, getPayments, loginAdmin, refreshAdminToken, updateApplicationStatus } from '../controllers/adminController';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import { verifyToken,AdminverifyToken } from '../middlewares/authMiddleware';
const router = express.Router();

router.get('/applications', getAllApplications);
router.patch('/applications/:id/status', updateApplicationStatus);
router.post("/create-admin",AdminverifyToken, authorizeRoles(['ADMIN']), createFirstAdmin);
router.post("/admin-login", loginAdmin);
router.get("/refresh", AdminverifyToken, refreshAdminToken)
router.get("/get-payments", AdminverifyToken, authorizeRoles(['ADMIN']), getPayments)
router.get("/get-activties", AdminverifyToken, authorizeRoles(['ADMIN']), getAllActivities)
router.get("/get-Analytics", AdminverifyToken, authorizeRoles(['ADMIN']), getAnalytics)
router.get("/get-all-internal-user", AdminverifyToken, authorizeRoles(['ADMIN']), getAllInternalUser)
router.get("/get-all-user", AdminverifyToken, authorizeRoles(['ADMIN']), getAllUser)


export default router;