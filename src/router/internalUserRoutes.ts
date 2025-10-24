import express from 'express';
import { createInternalUser, resendInternalVerification, setInternalUserPassword, updateSignature, uploadSignature, verifyInternalEmail } from '../controllers/internalUserController';
import { verifyToken } from '../middlewares/authMiddleware';
import { authorizeRoles } from '../middlewares/roleMiddleware';
import multer from 'multer';
const upload = multer({ dest: 'uploads/' });

const router = express.Router();

router.post('/', verifyToken, authorizeRoles(['ADMIN']), createInternalUser);
router.post('/upload-signature', verifyToken, authorizeRoles(['ADMIN']), upload.single('signature'), uploadSignature);
router.patch('/update-signature', verifyToken, authorizeRoles(['ADMIN']), upload.single('signature'), updateSignature);
router.get('/verify', verifyInternalEmail);
router.post('/set-password', setInternalUserPassword);
router.post('/resend-verification', resendInternalVerification);

export default router;