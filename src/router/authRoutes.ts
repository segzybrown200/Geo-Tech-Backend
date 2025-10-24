import express from 'express';
import { register, login, logout, getAllState } from '../controllers/authController';
const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);


router.get("/get-state", getAllState)

export default router;