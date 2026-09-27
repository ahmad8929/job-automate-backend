import { sql } from "./client.js";

// Normalizes company names for duplicate detection: "Acme, Inc." == "acme inc" == "ACME".
export const COMPANY_KEY_SQL = String.raw`regexp_replace(lower(company), '\m(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc)\M|[^a-z0-9]', '', 'g')`;

export async function getProfile() {
  const [row] = await sql`SELECT * FROM profile WHERE id = 1`;
  return row as {
    resume_text: string;
    resume_file_url: string | null;
    resume_file_name: string | null;
    resume_public_id: string | null;
    skills: string[];
    preferences: Record<string, unknown>;
    updated_at: string;
  };
}

/** Other applications to the same (normalized) company. */
export async function findDuplicates(company: string, excludeId?: number) {
  if (!company.trim()) return [];
  return sql.query(
    `SELECT id, company, role, status, applied_at, created_at FROM applications
     WHERE ${COMPANY_KEY_SQL} = regexp_replace(lower($1), '\\m(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc)\\M|[^a-z0-9]', '', 'g')
       AND ($2::bigint IS NULL OR id <> $2)
       AND status <> 'drafted' 
     ORDER BY created_at DESC`,
    [company, excludeId ?? null],
  );
}
