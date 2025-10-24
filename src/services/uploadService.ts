// services/uploadService.ts
import cloudinary from '../config/cloudinary';

export const uploadToCloudinary = async (filePath: string) => {
  return await cloudinary.uploader.upload(filePath, {
    folder: 'geotech_documents',
    resource_type: 'auto',
  });
};
