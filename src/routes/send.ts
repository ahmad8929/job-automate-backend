import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { HttpError } from "../config.js";
import { downloadResume } from "../lib/cloudinary.js";
import { sendEmail } from "../lib/gmail.js";
import { sql } from "../db/client.js";
import { getProfile } from "../db/queries.js";

export const sendRouter = Router();

const FOLLOWUP_DAYS = 7;

// Extra guard against accidental bulk sends.
sendRouter.use(rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, message: { error: "Send limit reached (40/hour)" } }));

const sendBody = z.object({
  application_id: z.coerce.number().int().positive(),
  to: z.email(),
  subject: z.string().trim().min(1).max(300).refine((s) => !/[\r\n]/.test(s), "Subject cannot contain line breaks"),
  body: z.string().trim().min(1).max(20_000),
  company: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  attach_resume: z.boolean().default(true),
  force: z.boolean().default(false), // allow re-sending an application that was already sent
});

/** POST /api/send — sends via Gmail with the resume attached, logs it, marks the application as sent. */
sendRouter.post("/", async (req, res) => {
  const input = sendBody.parse(req.body);

  const [app] = await sql`SELECT id, status FROM applications WHERE id = ${input.application_id}`;
  if (!app) throw new HttpError(404, "Application not found");
  if (app.status !== "drafted" && !input.force) {
    throw new HttpError(409, `This application was already ${app.status}. Resend anyway?`, { requires_force: true });
  }

  const profile = await getProfile();
  let attachment;
  if (input.attach_resume) {
    if (!profile.resume_public_id || !profile.resume_file_name) {
      throw new HttpError(409, "Upload your resume file on the Profile page first (or send without it).");
    }
    attachment = {
      filename: profile.resume_file_name,
      content: await downloadResume(profile.resume_public_id),
      contentType: profile.resume_file_name.endsWith(".pdf")
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }

  const fullName = typeof profile.preferences.full_name === "string" ? profile.preferences.full_name : undefined;
  const sent = await sendEmail({ to: input.to, subject: input.subject, body: input.body, fromName: fullName, attachment });

  const [log] = await sql`
    INSERT INTO email_log (application_id, recipient, subject, body, gmail_message_id, gmail_thread_id)
    VALUES (${input.application_id}, ${input.to}, ${input.subject}, ${input.body}, ${sent.messageId}, ${sent.threadId})
    RETURNING id, sent_at`;
  const [updated] = await sql`
    UPDATE applications SET status = 'sent', contact_email = ${input.to},
      company = COALESCE(${input.company ?? null}, company), role = COALESCE(${input.role ?? null}, role),
      draft_subject = ${input.subject}, draft_body = ${input.body},
      applied_at = now(), followup_at = now() + make_interval(days => ${FOLLOWUP_DAYS}), updated_at = now()
    WHERE id = ${input.application_id} RETURNING *`;

  res.json({ ok: true, email_log_id: log.id, sent_at: log.sent_at, application: updated });
});
