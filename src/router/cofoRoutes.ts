import express from 'express';
import multer from 'multer';
import { applyForCofO, getCofOById, resubmitCofO, reviewCofO, getMyCofOApplications, listCofOsForGovernor, getCofOForGovernor } from '../controllers/cofoController';
import { requireAuth, verifyToken, internalUserAuth } from '../middlewares/authMiddleware';
import { initializePayment, verifyPayment } from '../controllers/paymentController';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/apply/:cofOApplicationId', upload.array('documents'), requireAuth, applyForCofO);
router.post('/review/:id',internalUserAuth, reviewCofO); // :id = CofOApplication.id
router.post("/init", verifyToken, initializePayment);
router.get("/get-applications/:cofOId", requireAuth, getCofOById )
router.get("/verify", verifyPayment);
router.post("/re-submit/:cofOId", requireAuth, upload.array('documents'), resubmitCofO);
router.get("/my-cofo-applications", requireAuth, getMyCofOApplications);

// Governor routes: list and view CofOs for governor's state
router.get('/governor/cofos', internalUserAuth, listCofOsForGovernor);
router.get('/governor/cofo/:cofOId', internalUserAuth, getCofOForGovernor);

export default router;
