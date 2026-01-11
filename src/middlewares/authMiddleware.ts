import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { hashToken } from '../utils/tokens';


export interface AuthRequest extends Request {
  user?: any;
}

export const verifyToken = async(req: AuthRequest, res: Response, next: NextFunction) => {
   const token = req.cookies.geo_session;
    if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }
  try {
    // Verify Access Token 
    const verifiedTokenSession = await prisma.session.findUnique({
      where: {
        refreshTokenHash: hashToken(token),
      },
    });
    if (!verifiedTokenSession) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    req.user = { id: verifiedTokenSession.userId };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};
export const requireAuth = (req: AuthRequest, res: Response, next: Function) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ message: "Unauthorized" });

  const token = auth.split(" ")[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: "Token expired" });
  }
};

export const internalUserAuth = (req: any, res: Response, next: NextFunction) => {
    const token = req.cookies.token;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};