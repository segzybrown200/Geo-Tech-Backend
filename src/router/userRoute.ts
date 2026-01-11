import express from "express";
import { requireAuth, verifyToken } from "../middlewares/authMiddleware";
import { getUserDashboardOverview } from "../controllers/userContoller";



const router = express.Router();


router.get("/dashboard-overview", requireAuth, getUserDashboardOverview);




export default router;