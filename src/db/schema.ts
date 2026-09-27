// Idempotent schema. Each entry runs as its own statement (Neon's HTTP driver runs one statement per query).
// Token encryption is done in the app (AES-256-GCM, see lib/crypto.ts), so pgcrypto isn't required.
export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS profile (
    id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single-user: exactly one row
    resume_text      text        NOT NULL DEFAULT '',
    resume_file_url  text,
    resume_file_name text,
    resume_public_id text,
    skills           text[]      NOT NULL DEFAULT '{}',
    preferences      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`,
  `INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

  `CREATE TABLE IF NOT EXISTS applications (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company         text        NOT NULL,
    role            text        NOT NULL,
    contact_email   text,
    job_summary     text,
    job_description text,
    screenshot_url  text,
    source          text        NOT NULL CHECK (source IN ('screenshot', 'manual')),
    status          text        NOT NULL DEFAULT 'drafted'
                    CHECK (status IN ('drafted', 'sent', 'replied', 'interview', 'rejected')),
    draft_subject   text,
    draft_body      text,
    notes           text,
    applied_at      timestamptz,
    followup_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS applications_company_idx ON applications (lower(trim(company)))`,
  `CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status)`,
  `CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS email_log (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    application_id   bigint      NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    recipient        text        NOT NULL,
    subject          text        NOT NULL,
    body             text        NOT NULL,
    gmail_message_id text,
    gmail_thread_id  text,
    sent_at          timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS email_log_application_idx ON email_log (application_id)`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS poster_name text`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS location text`,

  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider                text        NOT NULL UNIQUE,
    account_email           text,
    encrypted_refresh_token text        NOT NULL,
    encrypted_access_token  text,       -- short-lived (~1h) cache only; refresh token is the source of truth
    expires_at              timestamptz,
    scope                   text,
    updated_at              timestamptz NOT NULL DEFAULT now()
  )`,
];
