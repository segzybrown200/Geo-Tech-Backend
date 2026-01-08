import { Request, Response } from 'express';
import { uploadToCloudinary } from '../services/uploadService';
import fs from 'fs';
import path from 'path';
import { AuthRequest } from '../middlewares/authMiddleware';

import prisma from "../lib/prisma";

export const submitApplication = async (req: AuthRequest, res: Response) => {
  const userId = req.user.id;
  const file = req.file;
  const { type } = req.body;

  if (!file) return res.status(400).json({ message: 'No file uploaded' });
  if (!type) return res.status(400).json({ message: 'Document type is required' });

  try {
        // ✅ Upload land documents (memory buffers -> cloudinary stream)
    const uploadResult = await uploadToCloudinary(fs.readFileSync(path.resolve(file.path)), file.originalname);

    // ✅ Create application record
    

    const application = await prisma.application.create({
      data: {
        userId,
        type,
        documentUrl: uploadResult.secure_url,
      },
    });

    fs.unlinkSync(path.resolve(file.path));

    res.status(201).json({ message: 'Application submitted', application });
  } catch (err) {
    res.status(500).json({ message: 'Upload failed', error: err });
  }
};