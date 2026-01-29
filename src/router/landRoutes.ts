import express from 'express';
import multer from 'multer';
import { deleteLand, getAllUserLands, getLandById, getLandCount, getLandsByState, registerLand, searchLandExistence, updateLand } from '../controllers/landController';
import { requireAuth,verifyToken } from '../middlewares/authMiddleware';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/land-register', upload.array('documents'), requireAuth, registerLand);
router.get('/get-land-info-byID/:landId', verifyToken, getLandById );
router.get('/get-user-lands', requireAuth, getAllUserLands );
router.get("/get-all-land-by-state/:stateId", verifyToken, getLandsByState);
router.delete("/delete-land/:id", requireAuth, deleteLand);
router.put("/update-land/:id", requireAuth, updateLand); // Placeholder for updateLand
router.get("/get-lands-count", verifyToken, getLandCount)
router.get("/search-lands", verifyToken, searchLandExistence);

export default router;