import { Router } from "express";
import rateLimit from "express-rate-limit";
import { classifyReply, getThreadReplies } from "../lib/gmail.js";
import { sql } from "../db/client.js";

export const gmailRouter = Router();

gmailRouter.use(rateLimit({ windowMs: 60 * 1000, limit: 5, message: { error: "Checking too often, wait a minute" } }));

// Only move statuses forward: sent → replied → interview/rejected.
const RANK = { sent: 0, replied: 1, interview: 2, rejected: 2 } as const;

/**
 * POST /api/gmail/check-replies — looks at the Gmail thread of every sent email and updates statuses by keyword.
 */
gmailRouter.post("/check-replies", async (_req, res) => {
  const rows = await sql`
    SELECT DISTINCT ON (a.id) a.id, a.company, a.role, a.status, e.gmail_thread_id, e.sent_at
    FROM applications a JOIN email_log e ON e.application_id = a.id
    WHERE a.status IN ('sent', 'replied') AND e.gmail_thread_id IS NOT NULL
    ORDER BY a.id, e.sent_at DESC`;

  const updates: { id: number; company: string; role: string; from: string; to: string; snippet: string }[] = [];
  for (const row of rows) {
    const replies = await getThreadReplies(row.gmail_thread_id, new Date(row.sent_at));
    if (!replies.length) continue;
    const latest = replies[replies.length - 1];
    const next = replies.map((r) => classifyReply(r.text)).reduce((best, c) => (RANK[c] > RANK[best] ? c : best), "replied" as const as keyof typeof RANK);
    if (RANK[next] <= RANK[row.status as keyof typeof RANK]) continue;
    await sql`UPDATE applications SET status = ${next}, updated_at = now() WHERE id = ${row.id}`;
    updates.push({ id: Number(row.id), company: row.company, role: row.role, from: row.status, to: next, snippet: latest.snippet });
  }
  res.json({ checked: rows.length, updated: updates });
});
