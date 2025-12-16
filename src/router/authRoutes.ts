import express from 'express';
import { register, login, logout, getAllState, verifyEmail, refresh, requestPasswordReset, resetPassword } from '../controllers/authController';
const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.post("/verify-email", verifyEmail)
router.post("refresh-token", refresh)
router.post("/request-password-reset", requestPasswordReset); // Request password reset
router.post("/reset-password", resetPassword);

router.get("/get-state", getAllState)

export default router;