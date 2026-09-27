import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { HttpError } from "../config.js";

// 4 MB: stays under Vercel's 4.5 MB request body limit for the Next.js proxy route.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
});

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const RESUME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * Validates by the file's real magic bytes, not the client-supplied mimetype or extension.
 */
export async function validateFile<T extends string>(
  file: Express.Multer.File | undefined,
  allowed: readonly T[],
): Promise<{ buffer: Buffer; mime: T; ext: string; safeName: string }> {
  if (!file) throw new HttpError(400, "No file uploaded");
  if (file.size === 0) throw new HttpError(400, "Uploaded file is empty");
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !(allowed as readonly string[]).includes(detected.mime)) {
    throw new HttpError(415, `Unsupported file type. Allowed: ${allowed.join(", ")}`);
  }
  const base = file.originalname.replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "file";
  return { buffer: file.buffer, mime: detected.mime as T, ext: detected.ext, safeName: `${base}.${detected.ext}` };
}
