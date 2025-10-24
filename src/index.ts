import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./router/authRoutes";
import applicationRoutes from "./router/applicationRoutes";
import adminRoutes from "./router/adminRoutes";
import { verifyToken } from "./middlewares/authMiddleware";
import internalUserRoutes from "./router/internalUserRoutes";
import landRoutes from "./router/landRoutes";
import cofoRoutes from "./router/cofoRoutes";
import ownershipRoutes from "./router/ownershipRoutes";
import cookieParser from "cookie-parser";

dotenv.config();
const app = express();
app.use(cookieParser());

app.use(
  cors({
    origin: ["http://localhost:5173", "https://your-production-frontend.com"],
    credentials: true, // if you use cookies or auth headers
  })
);
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/applications", verifyToken, applicationRoutes);
app.use(
  "/api/admin",adminRoutes);
app.use(
  "/api/internal-users",
  internalUserRoutes
);
app.use("/api/lands", verifyToken, landRoutes);
app.use("/api/cofo", verifyToken, cofoRoutes);
app.use("/api/ownership", verifyToken, ownershipRoutes);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
