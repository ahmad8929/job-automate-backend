import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../config.js";
import { draftEmail, resolveProvider } from "../lib/ai/index.js";
import { sql } from "../db/client.js";
import { getProfile } from "../db/queries.js";

export const draftRouter = Router();

const draftBody = z.object({
  application_id: z.coerce.number().int().positive().optional(),
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(200),
  contact_email: z.email().nullish().or(z.literal("")),
  job_summary: z.string().max(5000).nullish(),
  job_description: z.string().max(20_000).nullish(),
  screenshot_url: z.url().nullish(),
  source: z.enum(["screenshot", "manual"]),
  poster_name: z.string().max(200).nullish(),
  location: z.string().max(200).nullish(),
  note: z.string().max(5000).nullish(),
  instructions: z.string().max(1000).optional(),
  provider: z.string().optional(),
});

/** POST /api/draft — generates a tailored email and saves/updates the application as "drafted". */
draftRouter.post("/", async (req, res) => {
  const input = draftBody.parse(req.body);
  const profile = await getProfile();
  if (!profile.resume_text.trim()) {
    throw new HttpError(409, "Add your resume text on the Profile page before drafting.");
  }

  const { data: draft, provider } = await draftEmail(resolveProvider(input.provider, profile.preferences), {
    job: input,
    profile,
    note: input.note ?? undefined,
    instructions: input.instructions,
  });
  const contact = input.contact_email || null;

  let applicationId = input.application_id;
  if (applicationId) {
    const updated = await sql`
      UPDATE applications SET company = ${input.company}, role = ${input.role}, contact_email = ${contact},
        job_summary = ${input.job_summary ?? null}, job_description = ${input.job_description ?? null},
        poster_name = COALESCE(${input.poster_name ?? null}, poster_name), location = COALESCE(${input.location ?? null}, location),
        draft_subject = ${draft.subject}, draft_body = ${draft.body}, updated_at = now()
      WHERE id = ${applicationId} RETURNING id`;
    if (!updated.length) throw new HttpError(404, "Application not found");
  } else {
    const [row] = await sql`
      INSERT INTO applications (company, role, contact_email, job_summary, job_description, screenshot_url, source,
                                status, draft_subject, draft_body)
      VALUES (${input.company}, ${input.role}, ${contact}, ${input.job_summary ?? null}, ${input.job_description ?? null},
              ${input.screenshot_url ?? null}, ${input.source}, 'drafted', ${draft.subject}, ${draft.body})
      RETURNING id`;
    applicationId = Number(row.id);
  }

  res.json({ application_id: applicationId, ...draft, provider });
});
