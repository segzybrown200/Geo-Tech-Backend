import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './router/authRoutes';
import applicationRoutes from './router/applicationRoutes';
import adminRoutes from './router/adminRoutes';
import { verifyToken } from './middlewares/authMiddleware';
import { authorizeRoles } from './middlewares/roleMiddleware';
import internalUserRoutes from './router/internalUserRoutes';
import landRoutes from './router/landRoutes';
import cofoRoutes from './router/cofoRoutes';
import ownershipRoutes from './router/ownershipRoutes';


dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/applications', verifyToken, applicationRoutes);
app.use('/admin', verifyToken, authorizeRoles(['ADMIN', 'GOVERNMENT']), adminRoutes);
app.use('/internal-users', verifyToken, authorizeRoles(['ADMIN']), internalUserRoutes);
app.use('/lands', verifyToken, landRoutes);
app.use('/cofo', verifyToken, cofoRoutes);
app.use('/ownership', verifyToken, ownershipRoutes);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));