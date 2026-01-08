// services/uploadService.ts
import cloudinary from '../config/cloudinary';
import streamifier from 'streamifier';

export const uploadToCloudinary = (buffer: Buffer, filename?: string) => {
  return new Promise<any>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'geotech_documents',
        resource_type: 'auto',
        public_id: filename ? filename.replace(/\.[^.]+$/, '') : undefined,
      },
      (error: any, result: any) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};
