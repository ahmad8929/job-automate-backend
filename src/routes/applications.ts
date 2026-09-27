import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../config.js";
import { sql } from "../db/client.js";
import { COMPANY_KEY_SQL, findDuplicates } from "../db/queries.js";

export const applicationsRouter = Router();

const STATUSES = ["drafted", "sent", "replied", "interview", "rejected"] as const;

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  source: z.enum(["screenshot", "manual"]).optional(),
  from: z.iso.date().optional(), // YYYY-MM-DD, filters on created_at
  to: z.iso.date().optional(),
  q: z.string().trim().max(100).optional(),
});

/** GET /api/applications?status=&source=&from=&to=&q= */
applicationsRouter.get("/", async (req, res) => {
  const f = listQuery.parse(req.query);
  const rows = await sql.query(
    `SELECT a.*,
            ${COMPANY_KEY_SQL} AS company_key,
            (a.followup_at IS NOT NULL AND a.followup_at < now() AND a.status = 'sent') AS followup_due
     FROM applications a
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR source = $2)
       AND ($3::date IS NULL OR created_at >= $3::date)
       AND ($4::date IS NULL OR created_at < $4::date + 1)
       AND ($5::text IS NULL OR company ILIKE '%' || $5 || '%' OR role ILIKE '%' || $5 || '%')
     ORDER BY created_at DESC`,
    [f.status ?? null, f.source ?? null, f.from ?? null, f.to ?? null, f.q || null],
  );
  // Count duplicates across all applications, not just the filtered rows, so filters don't hide them.
  const allCounts = await sql.query(
    `SELECT ${COMPANY_KEY_SQL} AS key, count(*)::int AS n FROM applications WHERE status <> 'drafted' GROUP BY 1`,
  );
  const counts = new Map(allCounts.map((r) => [r.key as string, r.n as number]));
  res.json(
    rows.map(({ company_key, ...r }) => {
      const contacted = counts.get(company_key) ?? 0;
      return { ...r, duplicate_count: Math.max(0, contacted - (r.status === "drafted" ? 0 : 1)) };
    }),
  );
});

/** GET /api/applications/stats — counts per status + reply rate. */
applicationsRouter.get("/stats", async (_req, res) => {
  const rows = await sql`SELECT status, count(*)::int AS n FROM applications GROUP BY status`;
  const by = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const r of rows) by[r.status as keyof typeof by] = r.n;
  const contacted = by.sent + by.replied + by.interview + by.rejected;
  const responded = by.replied + by.interview + by.rejected;
  const [{ due }] = await sql`SELECT count(*)::int AS due FROM applications WHERE status = 'sent' AND followup_at < now()`;
  res.json({ by_status: by, contacted, responded, reply_rate: contacted ? responded / contacted : 0, followups_due: due });
});

/** GET /api/applications/check-duplicate?company= */
applicationsRouter.get("/check-duplicate", async (req, res) => {
  const { company, exclude } = z
    .object({ company: z.string().max(200), exclude: z.coerce.number().int().optional() })
    .parse(req.query);
  res.json({ duplicates: await findDuplicates(company, exclude) });
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** GET /api/applications/:id — includes the email log. */
applicationsRouter.get("/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const [app] = await sql`SELECT * FROM applications WHERE id = ${id}`;
  if (!app) throw new HttpError(404, "Application not found");
  const emails = await sql`SELECT * FROM email_log WHERE application_id = ${id} ORDER BY sent_at DESC`;
  res.json({ ...app, emails });
});

const patchBody = z
  .object({
    status: z.enum(STATUSES),
    followup_at: z.iso.datetime({ offset: true }).nullable(),
    notes: z.string().max(5000).nullable(),
    company: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(200),
    contact_email: z.email().nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");

/** PATCH /api/applications/:id — manual status / field update. */
applicationsRouter.patch("/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const b = patchBody.parse(req.body);
  const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k);
  const [row] = await sql`
    UPDATE applications SET
      status        = CASE WHEN ${has("status")}        THEN ${b.status ?? null}        ELSE status END,
      followup_at   = CASE WHEN ${has("followup_at")}   THEN ${b.followup_at ?? null}::timestamptz ELSE followup_at END,
      notes         = CASE WHEN ${has("notes")}         THEN ${b.notes ?? null}         ELSE notes END,
      company       = CASE WHEN ${has("company")}       THEN ${b.company ?? null}       ELSE company END,
      role          = CASE WHEN ${has("role")}          THEN ${b.role ?? null}          ELSE role END,
      contact_email = CASE WHEN ${has("contact_email")} THEN ${b.contact_email ?? null} ELSE contact_email END,
      updated_at = now()
    WHERE id = ${id} RETURNING *`;
  if (!row) throw new HttpError(404, "Application not found");
  res.json(row);
});

/** DELETE /api/applications/:id — only drafts can be deleted, sent history is kept. */
applicationsRouter.delete("/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const [row] = await sql`DELETE FROM applications WHERE id = ${id} AND status = 'drafted' RETURNING id`;
  if (!row) throw new HttpError(409, "Only drafted (unsent) applications can be deleted");
  res.json({ ok: true });
});
