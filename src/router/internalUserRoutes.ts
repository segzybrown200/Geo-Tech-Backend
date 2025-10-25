import express from 'express';
import { createInternalUser, getInternalUserSession, loginInternalUser, refreshInternalToken, resendInternalVerification, setInternalUserPassword, updateSignature, uploadSignature, verifyInternalEmail } from '../controllers/internalUserController';
import { internalUserAuth, verifyToken } from '../middlewares/authMiddleware';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import multer from 'multer';
const upload = multer({ dest: 'uploads/' });

const router = express.Router();

router.post('/', verifyToken, authorizeRoles(['ADMIN']), createInternalUser);
router.post('/upload-signature', verifyToken, authorizeRoles(['GOVERNOR']), upload.single('signature'), uploadSignature);
router.patch('/update-signature', verifyToken, authorizeRoles(['GOVERNOR']), upload.single('signature'), updateSignature);
router.get('/verify', verifyInternalEmail);
router.post('/set-password', setInternalUserPassword);
router.post('/resend-verification', resendInternalVerification);
router.post("/login", loginInternalUser);
router.get("/session", internalUserAuth, getInternalUserSession);
router.get("/refresh", verifyToken, refreshInternalToken);


export default router;