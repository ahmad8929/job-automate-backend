import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../config.js";
import { extractFromImage, extractFromText, resolveProvider, type ImageType } from "../lib/ai/index.js";
import { cloudinaryEnabled, uploadScreenshot } from "../lib/cloudinary.js";
import { IMAGE_TYPES, upload, validateFile } from "../lib/uploads.js";
import { findDuplicates, getProfile } from "../db/queries.js";

export const extractRouter = Router();

const textBody = z.object({ provider: z.string().optional(), text: z.string().trim().min(20, "Paste at least a few sentences").max(20_000) });

/**
 * POST /api/extract
 *  - multipart/form-data with field "screenshot" (+ optional "notes"), or
 *  - JSON { text } for a pasted job description.
 */
extractRouter.post("/", upload.single("screenshot"), async (req, res) => {
  const provider = resolveProvider(req.body?.provider, (await getProfile()).preferences);
  let result;
  let screenshotUrl: string | null = null;
  let warning: string | undefined;

  if (req.file) {
    const file = await validateFile(req.file, IMAGE_TYPES);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 2000) : undefined;
    const [extracted, uploaded] = await Promise.allSettled([
      extractFromImage(provider, file.buffer, file.mime as ImageType, notes),
      cloudinaryEnabled() ? uploadScreenshot(file.buffer) : Promise.resolve(null),
    ]);
    if (extracted.status === "rejected") throw extracted.reason;
    result = extracted.value;
    if (uploaded.status === "fulfilled") screenshotUrl = uploaded.value;
    else warning = "Screenshot could not be saved to Cloudinary (extraction still worked).";
  } else if (req.is("application/json")) {
    const { text } = textBody.parse(req.body);
    result = await extractFromText(provider, text);
  } else {
    throw new HttpError(400, "Send a screenshot file or JSON { text }");
  }

  const job = result.data;
  const email = job.contact_email?.trim();
  const contactEmail = email && z.email().safeParse(email).success ? email : null;
  const duplicates = await findDuplicates(job.company);

  res.json({
    job: { ...job, contact_email: contactEmail },
    source: req.file ? "screenshot" : "manual",
    provider: result.provider,
    screenshot_url: screenshotUrl,
    duplicates,
    warning: warning ?? (job.is_job_post ? undefined : "This doesn't look like a job post — double-check the details."),
  });
});
