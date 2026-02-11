import express from 'express';
import { approveUserLand, createFirstAdmin, getAllActivities, getAllApplications, getAllInternalUser, getAllUser, getAnalytics, getLandRegistrationsCount, getPayments, loginAdmin, refreshAdminToken, rejectUserLand, updateApplicationStatus } from '../controllers/adminController';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import { verifyToken,AdminverifyToken } from '../middlewares/authMiddleware';
import { getAllLands, getAllUserLands, getLandById } from '../controllers/landController';
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
router.get("/approve-user-land/:landId", AdminverifyToken, authorizeRoles(['ADMIN']), approveUserLand)
router.get("/reject-user-land/:landId", AdminverifyToken, authorizeRoles(['ADMIN']), rejectUserLand)
router.get("/")
router.get("/get-registered-lands", AdminverifyToken, authorizeRoles(['ADMIN']),  getAllUserLands);
router.get("/land-registered-count", AdminverifyToken, authorizeRoles(['ADMIN']),  getLandRegistrationsCount);
router.get("/get-all-lands", AdminverifyToken, authorizeRoles(['ADMIN']), getAllLands);
router.get('/get-land-info-byID/:landId', AdminverifyToken, authorizeRoles(['ADMIN']), getLandById );
router.post()
export default router;