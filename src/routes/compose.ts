import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../config.js";
import { sql } from "../db/client.js";
import { findDuplicates, getProfile } from "../db/queries.js";
import { composeApplication, resolveProvider, type ImageType } from "../lib/ai/index.js";
import { cloudinaryEnabled, uploadScreenshot } from "../lib/cloudinary.js";
import { IMAGE_TYPES, upload, validateFile } from "../lib/uploads.js";

export const composeRouter = Router();

/** "dmdc.ae" → "DMDC", "northwindlabs.io" → "Northwindlabs"; other names unchanged. */
function cleanCompany(raw: string) {
  const name = raw.trim();
  const domain = name.match(/^(?:www\.)?([a-z0-9-]+)\.[a-z.]{2,}$/i);
  if (!domain) return name;
  const label = domain[1];
  return label.length <= 5 ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1);
}

const composeBody = z.object({
  text: z.string().max(20_000).optional(),
  notes: z.string().max(1000).optional(),
  provider: z.string().optional(),
  application_id: z.coerce.number().int().positive().optional(), // re-running an edited post updates the same draft
});

/**
 * POST /api/compose — the one-step flow: multipart with optional "screenshot" + "text".
 * Reads the post and writes the email in a single AI call, then saves it as a drafted application.
 */
composeRouter.post("/", upload.single("screenshot"), async (req, res) => {
  const input = composeBody.parse(req.body ?? {});
  const text = input.text?.trim();
  if (!req.file && (!text || text.length < 20)) {
    throw new HttpError(400, "Paste the job post or attach a screenshot");
  }

  const profile = await getProfile();
  if (!profile.resume_text.trim()) throw new HttpError(409, "Add your resume on the Profile page first.");

  const image = req.file ? await validateFile(req.file, IMAGE_TYPES) : null;
  // With a screenshot, the typed text is the candidate's note for this email; without one, it's the job post.
  const postText = image ? undefined : text;
  const note = image ? text : undefined;
  const [composed, uploaded] = await Promise.allSettled([
    composeApplication(resolveProvider(input.provider, profile.preferences), {
      profile,
      text: postText,
      note,
      image: image ? { data: image.buffer, mime: image.mime as ImageType } : undefined,
      notes: input.notes?.trim() || undefined,
    }),
    image && cloudinaryEnabled() ? uploadScreenshot(image.buffer) : Promise.resolve(null),
  ]);
  if (composed.status === "rejected") throw composed.reason;
  const { data: c, provider } = composed.value;

  const email = c.contact_email?.trim();
  const contactEmail = email && z.email().safeParse(email).success ? email : null;
  const company = cleanCompany(c.company) || "Unknown company";
  const role = c.role.trim() || "Unknown role";

  const screenshotUrl = uploaded.status === "fulfilled" ? uploaded.value : null;
  const source = image ? "screenshot" : "manual";
  let row;
  if (input.application_id) {
    [row] = await sql`
      UPDATE applications SET company = ${company}, role = ${role}, contact_email = ${contactEmail},
        job_summary = ${c.job_summary || null}, job_description = ${postText || null}, notes = ${note || null},
        screenshot_url = COALESCE(${screenshotUrl}, screenshot_url), source = ${source},
        draft_subject = ${c.subject}, draft_body = ${c.body}, poster_name = ${c.poster_name || null},
        location = ${c.location || null}, updated_at = now()
      WHERE id = ${input.application_id} AND status = 'drafted'
      RETURNING id`;
  }
  row ??= (
    await sql`
      INSERT INTO applications (company, role, contact_email, job_summary, job_description, notes, screenshot_url,
                                source, status, draft_subject, draft_body, poster_name, location)
      VALUES (${company}, ${role}, ${contactEmail}, ${c.job_summary || null}, ${postText || null}, ${note || null},
              ${screenshotUrl}, ${source}, 'drafted', ${c.subject}, ${c.body}, ${c.poster_name || null},
              ${c.location || null})
      RETURNING id`
  )[0];
  const applicationId = Number(row.id);

  res.json({
    application_id: applicationId,
    provider,
    company,
    role,
    contact_email: contactEmail,
    poster_name: c.poster_name,
    location: c.location,
    is_outside_india: c.is_outside_india,
    job_summary: c.job_summary,
    subject: c.subject,
    body: c.body,
    duplicates: await findDuplicates(company, applicationId),
    warning: c.is_job_post ? undefined : "This doesn't look like a job post — double-check before sending.",
  });
});
