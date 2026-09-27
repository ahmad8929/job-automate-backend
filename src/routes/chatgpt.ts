import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../config.js";
import { sql } from "../db/client.js";
import { findDuplicates, getProfile } from "../db/queries.js";
import { buildChatGptPrompt, parseChatGptReply } from "../lib/chatgpt.js";

export const chatgptRouter = Router();

/** POST /api/chatgpt/prompt — the ready-to-paste prompt with the saved profile baked in. */
chatgptRouter.post("/prompt", async (req, res) => {
  const { notes } = z.object({ notes: z.string().max(1000).optional() }).parse(req.body ?? {});
  const profile = await getProfile();
  res.json({ prompt: buildChatGptPrompt(profile, notes), profile_ready: Boolean(profile.resume_text.trim()) });
});

const importBody = z.object({
  reply: z.string().trim().min(20).max(30_000),
  source: z.enum(["screenshot", "manual"]).default("screenshot"),
  application_id: z.coerce.number().int().positive().optional(), // re-import into the same draft
});

/** POST /api/chatgpt/import — parses ChatGPT's reply and saves it as a drafted application. */
chatgptRouter.post("/import", async (req, res) => {
  const input = importBody.parse(req.body);
  const parsed = parseChatGptReply(input.reply);
  const company = parsed.company || "Unknown company";
  const role = parsed.role || "Unknown role";

  let applicationId = input.application_id;
  if (applicationId) {
    const updated = await sql`
      UPDATE applications SET company = ${company}, role = ${role}, contact_email = ${parsed.contact_email},
        job_summary = ${parsed.job_summary || null}, draft_subject = ${parsed.subject}, draft_body = ${parsed.body},
        updated_at = now()
      WHERE id = ${applicationId} AND status = 'drafted' RETURNING id`;
    if (!updated.length) throw new HttpError(404, "Draft not found (or already sent)");
  } else {
    const [row] = await sql`
      INSERT INTO applications (company, role, contact_email, job_summary, source, status, draft_subject, draft_body)
      VALUES (${company}, ${role}, ${parsed.contact_email}, ${parsed.job_summary || null}, ${input.source}, 'drafted',
              ${parsed.subject}, ${parsed.body})
      RETURNING id`;
    applicationId = Number(row.id);
  }

  res.json({
    application_id: applicationId,
    ...parsed,
    company,
    role,
    duplicates: await findDuplicates(company, applicationId),
  });
});
