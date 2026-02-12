// services/uploadService.ts
import cloudinary from '../config/cloudinary';
import streamifier from 'streamifier';

// Allowed file types for CofO documents
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
];

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx'];

// Determine resource type based on file extension or MIME type
const getResourceType = (filename: string, mimeType: string): 'image' | 'raw' => {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  
  // Image types
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
    return 'image';
  }
  
  // Document types (PDF, DOC, DOCX, etc.)
  if (['.pdf', '.doc', '.docx'].includes(ext)) {
    return 'raw';
  }
  
  // Default to raw for unknown types
  return 'raw';
};

export const validateDocumentFile = (
  buffer: Buffer,
  filename: string,
  mimeType: string
): { valid: boolean; error?: string } => {
  // Check file extension
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `File type ${ext} not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`,
    };
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return {
      valid: false,
      error: `MIME type ${mimeType} not allowed`,
    };
  }

  // Check file size (max 10MB)
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (buffer.length > maxSize) {
    return {
      valid: false,
      error: `File size exceeds 10MB limit`,
    };
  }

  return { valid: true };
};

export const uploadToCloudinary = (
  buffer: Buffer,
  filename?: string,
  mimeType?: string,
  options?: { folder?: string; resourceType?: 'image' | 'raw' }
) => {
  return new Promise<any>((resolve, reject) => {
    const inferredResource = getResourceType(filename || '', mimeType || '');
    const resourceType = options?.resourceType ?? inferredResource;
    const folder = options?.folder ?? 'geotech_documents';

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        public_id: filename ? filename.replace(/\.[^.]+$/, '') : undefined,
        use_filename: true,
      },
      (error: any, result: any) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};
export const uploadToCerificateCloudinary = (
  buffer: Buffer,
  filename?: string,
  mimeType?: string,
  options?: { folder?: string; resourceType?: 'image' | 'raw' }
) => {
  return new Promise<any>((resolve, reject) => {
    const inferredResource = getResourceType(filename || '', mimeType || '');
    const resourceType = options?.resourceType ?? inferredResource;
    const folder = options?.folder ?? 'geotech_documents';
    const publicId = filename ?? `${Date.now()}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        public_id: publicId,
      },
      (error: any, result: any) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};
