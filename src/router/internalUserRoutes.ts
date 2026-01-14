import express from 'express';
import { createInternalUser, getInternalUserSession, loginInternalUser, refreshInternalToken, resendInternalVerification, setInternalUserPassword, updateSignature, uploadSignature, verifyInternalEmail } from '../controllers/internalUserController';
import { internalUserAuth, AdminverifyToken } from '../middlewares/authMiddleware';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import multer from 'multer';
const upload = multer({ dest: 'uploads/' });

const router = express.Router();

router.post('/', AdminverifyToken, authorizeRoles(['ADMIN']), createInternalUser);
router.post('/upload-signature', AdminverifyToken, authorizeRoles(['GOVERNOR']), upload.single('signature'), uploadSignature);
router.patch('/update-signature', AdminverifyToken, authorizeRoles(['GOVERNOR']), upload.single('signature'), updateSignature);
router.get('/verify', verifyInternalEmail);
router.post('/set-password', setInternalUserPassword);
router.post('/resend-verification', resendInternalVerification);
router.post("/login", loginInternalUser);
router.get("/session", internalUserAuth, getInternalUserSession);
router.get("/refresh", AdminverifyToken, refreshInternalToken);


export default router;