# Job Apply — Backend (Express + TypeScript)

Personal API: extracts job posts with Gemini, ChatGPT or Claude (pick per request; "auto" falls back to the other), drafts emails, sends via Gmail with resume attached, tracks applications in Neon.

## Local setup
```bash
cp .env.example .env      # fill in values (see comments inside)
npm install
npm run db:migrate        # creates tables (idempotent, safe to re-run)
npm run dev               # http://localhost:4000, /health checks the DB
```

## Routes (all under /api require `x-api-key`, sent by the Next.js server only)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/ai/providers | which AI providers are configured + models |
| POST | /api/chatgpt/prompt · /api/chatgpt/import | free "Via ChatGPT" mode: build the prompt / parse the pasted reply into a draft |
| POST | /api/extract | multipart `screenshot` or JSON `{text}` → structured job info + duplicate matches |
| POST | /api/draft | job info → tailored subject/body; creates/updates the application as `drafted` |
| POST | /api/send | sends via Gmail with resume attached, logs to `email_log`, status → `sent`, follow-up +7d |
| GET | /api/applications | filters: `status`, `source`, `from`, `to` (YYYY-MM-DD), `q` |
| GET | /api/applications/stats · /check-duplicate?company= · /:id | |
| PATCH | /api/applications/:id | status, followup_at, notes, company, role, contact_email |
| DELETE | /api/applications/:id | drafts only |
| GET/PUT | /api/profile · POST /api/profile/resume | profile + resume file (PDF/DOCX) |
| POST | /api/oauth/google | returns Google consent URL (callback: GET /api/oauth/google/callback, public, signed `state`) |
| GET/DELETE | /api/oauth/google/status · /api/oauth/google | connection status / disconnect + revoke |
| POST | /api/gmail/check-replies | scans sent threads, updates status by keywords |

## Security
- OAuth tokens encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) before hitting the DB; access tokens are only a short-lived encrypted cache.
- Only `ALLOWED_EMAIL` can be connected as the Gmail account.
- Uploads: 4 MB max, type verified by magic bytes (images: png/jpeg/webp/gif; resume: pdf/docx).
- Rate limits: 300 req/15 min global, 15/min on Claude routes, 40 sends/hour, 5 reply checks/min.
- CORS allowlist from `CORS_ORIGINS`; helmet headers.

## Deploy to Hostinger VPS
```bash
# on the VPS (Node 22+), after cloning this repo
npm ci && npm run build && npm run db:migrate
NODE_ENV=production pm2 start dist/index.js --name job-apply-api && pm2 save
```
Put Nginx in front with HTTPS (certbot) proxying `api.yourdomain.com` → `localhost:4000`. In production `.env` set:
`NODE_ENV=production`, `CORS_ORIGINS=https://<your-app>.vercel.app`, `FRONTEND_URL=https://<your-app>.vercel.app`,
`GOOGLE_REDIRECT_URI=https://api.yourdomain.com/api/oauth/google/callback` (and add that URI in Google Cloud).
