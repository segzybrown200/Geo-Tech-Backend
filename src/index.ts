import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./router/authRoutes";
import adminRoutes from "./router/adminRoutes";
import userRoutes from "./router/userRoute";
import paymentRoutes from "./router/payment";
import { verifyToken } from "./middlewares/authMiddleware";
import internalUserRoutes from "./router/internalUserRoutes";
import landRoutes from "./router/landRoutes";
import cofoRoutes from "./router/cofoRoutes";
import ownershipRoutes from "./router/ownershipRoutes";
import cookieParser from "cookie-parser";

dotenv.config();
const app = express();
app.use(cookieParser());

const allowedOrigins = [
  "http://localhost:5173", // local dev
  "https://geo-tech-six.vercel.app", // production (exact origin used by Vercel)
  "https://www.geo-tech-six.vercel.app", // production www
  "https://geo-tech-reviewer.vercel.app",
  "https://www.geo-tech-reviewer.vercel.app"
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("❌ CORS blocked for origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
  })
);
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use(
  "/api/admin",adminRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/payments", paymentRoutes);
app.use(
  "/api/internal-users",
  internalUserRoutes
);
app.use("/api/lands", verifyToken, landRoutes);
app.use("/api/cofo",  cofoRoutes);
app.use("/api/ownership", verifyToken, ownershipRoutes);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
