import { Router } from "express";
import { z } from "zod";
import { sql } from "../db/client.js";
import { getProfile } from "../db/queries.js";
import { deleteResume, downloadResume, uploadResume } from "../lib/cloudinary.js";
import { HttpError } from "../config.js";
import { RESUME_TYPES, upload, validateFile } from "../lib/uploads.js";

export const profileRouter = Router();

profileRouter.get("/", async (_req, res) => {
  const { resume_public_id: _omit, ...profile } = await getProfile();
  res.json(profile);
});

const preferencesSchema = z
  .object({
    full_name: z.string().max(200),
    phone: z.string().max(50),
    linkedin_url: z.string().max(300),
    portfolio_url: z.string().max(300),
    target_roles: z.string().max(500),
    tone: z.enum(["professional", "friendly", "concise", "enthusiastic"]),
    extra_instructions: z.string().max(2000),
    abroad_instructions: z.string().max(1000),
    career_start: z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM").or(z.literal("")),
    ai_provider: z.enum(["auto", "gemini", "openai", "anthropic"]),
  })
  .partial();

const profileBody = z.object({
  resume_text: z.string().max(50_000),
  skills: z.array(z.string().trim().min(1).max(60)).max(100),
  preferences: preferencesSchema,
});

profileRouter.put("/", async (req, res) => {
  const p = profileBody.parse(req.body);
  await sql`
    UPDATE profile SET resume_text = ${p.resume_text}, skills = ${p.skills},
      preferences = ${JSON.stringify(p.preferences)}::jsonb, updated_at = now()
    WHERE id = 1`;
  const { resume_public_id: _omit, ...profile } = await getProfile();
  res.json(profile);
});

/** GET /api/profile/resume/file — streams the stored resume (public Cloudinary delivery may be blocked). */
profileRouter.get("/resume/file", async (_req, res) => {
  const p = await getProfile();
  if (!p.resume_public_id || !p.resume_file_name) throw new HttpError(404, "No resume uploaded");
  const pdf = p.resume_file_name.toLowerCase().endsWith(".pdf");
  res
    .type(pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    .setHeader("Content-Disposition", `inline; filename="${p.resume_file_name}"`)
    .send(await downloadResume(p.resume_public_id));
});

/** POST /api/profile/resume — multipart field "resume" (PDF or DOCX). Replaces the previous file. */
profileRouter.post("/resume", upload.single("resume"), async (req, res) => {
  const file = await validateFile(req.file, RESUME_TYPES);
  const previous = await getProfile();
  const { url, publicId } = await uploadResume(file.buffer, file.safeName);
  await sql`
    UPDATE profile SET resume_file_url = ${url}, resume_file_name = ${file.safeName},
      resume_public_id = ${publicId}, updated_at = now()
    WHERE id = 1`;
  if (previous.resume_public_id) await deleteResume(previous.resume_public_id);
  res.json({ resume_file_url: url, resume_file_name: file.safeName });
});
