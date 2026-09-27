import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { config, HttpError } from "../config.js";

// The SDK reads CLOUDINARY_URL from the environment automatically.
cloudinary.config({ secure: true });

export const cloudinaryEnabled = () => Boolean(config.CLOUDINARY_URL);

function uploadBuffer(buffer: Buffer, options: Record<string, unknown>): Promise<UploadApiResponse> {
  if (!cloudinaryEnabled()) throw new HttpError(503, "CLOUDINARY_URL is not configured on the backend");
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => (err || !result ? reject(err ?? new Error("Upload failed")) : resolve(result)))
      .end(buffer);
  });
}

export async function uploadScreenshot(buffer: Buffer) {
  const res = await uploadBuffer(buffer, { folder: "job-apply/screenshots", resource_type: "image" });
  return res.secure_url;
}

export async function uploadResume(buffer: Buffer, fileName: string) {
  // "raw" delivery: Cloudinary blocks PDF delivery as images on free accounts by default.
  const res = await uploadBuffer(buffer, {
    folder: "job-apply/resume",
    resource_type: "raw",
    public_id: `${Date.now()}_${fileName}`,
  });
  return { url: res.secure_url, publicId: res.public_id };
}

export async function deleteResume(publicId: string) {
  await cloudinary.uploader.destroy(publicId, { resource_type: "raw" }).catch(() => undefined);
}

/**
 * Downloads the stored resume through Cloudinary's signed API download (uses the API secret), so it works even
 * when the account blocks public delivery of PDFs (new accounts return 401 on the public URL).
 */
export async function downloadResume(publicId: string): Promise<Buffer> {
  if (!cloudinaryEnabled()) throw new HttpError(503, "CLOUDINARY_URL is not configured on the backend");
  const url = cloudinary.utils.private_download_url(publicId, "", {
    resource_type: "raw",
    type: "upload",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(502, `Could not download resume from Cloudinary (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
