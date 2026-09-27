import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import nodemailer from "nodemailer";
import { config, HttpError, requireConfig } from "../config.js";
import { sql } from "../db/client.js";
import { createOAuthState, decrypt, encrypt } from "./crypto.js";

const PROVIDER = "google";
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
];

function newOAuthClient() {
  return new OAuth2Client({
    clientId: requireConfig("GOOGLE_CLIENT_ID"),
    clientSecret: requireConfig("GOOGLE_CLIENT_SECRET"),
    redirectUri: config.GOOGLE_REDIRECT_URI,
  });
}

export function getAuthUrl(): string {
  return newOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    scope: GMAIL_SCOPES,
    state: createOAuthState(),
    login_hint: config.ALLOWED_EMAIL,
    include_granted_scopes: true,
  });
}

/** Exchanges the OAuth code, verifies the account is the allowed one, and stores the encrypted refresh token. */
export async function handleOAuthCallback(code: string): Promise<string> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new HttpError(400, "Google did not return a refresh token. Remove the app's access in your Google account and try again.");
  if (!tokens.id_token) throw new HttpError(400, "Google did not return an ID token");

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: requireConfig("GOOGLE_CLIENT_ID") });
  const email = ticket.getPayload()?.email?.toLowerCase();
  if (!email || email !== config.ALLOWED_EMAIL.toLowerCase()) {
    throw new HttpError(403, `Only ${config.ALLOWED_EMAIL} can be connected`);
  }

  await sql`
    INSERT INTO oauth_tokens (provider, account_email, encrypted_refresh_token, encrypted_access_token, expires_at, scope, updated_at)
    VALUES (${PROVIDER}, ${email}, ${encrypt(tokens.refresh_token)},
            ${tokens.access_token ? encrypt(tokens.access_token) : null},
            ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null}, ${tokens.scope ?? null}, now())
    ON CONFLICT (provider) DO UPDATE SET
      account_email = EXCLUDED.account_email,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      updated_at = now()`;
  return email;
}

export async function getConnectionStatus() {
  const [row] = await sql`SELECT account_email, scope, updated_at FROM oauth_tokens WHERE provider = ${PROVIDER}`;
  return row ? { connected: true, email: row.account_email as string, connected_at: row.updated_at } : { connected: false };
}

export async function disconnect() {
  const [row] = await sql`SELECT encrypted_refresh_token FROM oauth_tokens WHERE provider = ${PROVIDER}`;
  if (row && config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    await newOAuthClient().revokeToken(decrypt(row.encrypted_refresh_token)).catch(() => undefined);
  }
  await sql`DELETE FROM oauth_tokens WHERE provider = ${PROVIDER}`;
}

async function getGmail(): Promise<{ gmail: gmail_v1.Gmail; email: string }> {
  const [row] = await sql`SELECT * FROM oauth_tokens WHERE provider = ${PROVIDER}`;
  if (!row) throw new HttpError(409, "Gmail is not connected. Connect it on the Profile page.");

  const client = newOAuthClient();
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  client.setCredentials({
    refresh_token: decrypt(row.encrypted_refresh_token),
    ...(row.encrypted_access_token && expiresAt > Date.now() + 60_000
      ? { access_token: decrypt(row.encrypted_access_token), expiry_date: expiresAt }
      : {}),
  });
  // Persist refreshed (short-lived) access tokens, encrypted.
  client.on("tokens", (tokens) => {
    if (!tokens.access_token) return;
    void sql`
      UPDATE oauth_tokens SET encrypted_access_token = ${encrypt(tokens.access_token)},
        expires_at = ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null},
        encrypted_refresh_token = COALESCE(${tokens.refresh_token ? encrypt(tokens.refresh_token) : null}, encrypted_refresh_token),
        updated_at = now()
      WHERE provider = ${PROVIDER}`.catch((e) => console.error("Failed to persist refreshed token", e));
  });
  return { gmail: gmailApi({ version: "v1", auth: client }), email: row.account_email };
}

function wrapGoogleError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_grant/i.test(message)) {
    throw new HttpError(401, "Gmail authorization expired or was revoked. Reconnect Gmail on the Profile page.");
  }
  throw new HttpError(502, `Gmail API error: ${message}`);
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
  attachment?: { filename: string; content: Buffer; contentType: string };
}

export async function sendEmail(input: SendEmailInput) {
  const { gmail, email } = await getGmail();
  // nodemailer only builds the RFC 822 message (with safe header encoding); Gmail API does the sending.
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const built = await composer.sendMail({
    from: input.fromName ? { name: input.fromName, address: email } : email,
    to: input.to,
    subject: input.subject,
    text: input.body,
    attachments: input.attachment ? [input.attachment] : [],
  });
  const raw = Buffer.from(built.message as Buffer).toString("base64url");
  try {
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return { messageId: res.data.id ?? null, threadId: res.data.threadId ?? null };
  } catch (err) {
    wrapGoogleError(err);
  }
}

// ---- Reply detection -------------------------------------------------------

const REJECTION_PATTERNS = [
  /not (be )?moving forward/i,
  /decided (not )?to (move|proceed|pursue) (forward )?with other/i,
  /(pursue|proceed|move forward) with other candidates/i,
  /position has (already )?been filled/i,
  /will not be proceeding/i,
  /not (a|the right) (good )?fit/i,
  /regret to inform/i,
  /unfortunately,? (we|after)/i,
];
const INTERVIEW_PATTERNS = [
  /schedule (a|an) (call|chat|interview|meeting|time)/i,
  /\binterview\b/i,
  /your availability/i,
  /(calendly|cal\.com)\//i,
  /set up (a )?(time|call)/i,
  /(hop|jump) on a (quick )?call/i,
  /next steps?/i,
  /(technical|coding) (assessment|test|challenge)/i,
];

export type ReplyClassification = "rejected" | "interview" | "replied";

export function classifyReply(text: string): ReplyClassification {
  if (REJECTION_PATTERNS.some((re) => re.test(text))) return "rejected";
  if (INTERVIEW_PATTERNS.some((re) => re.test(text))) return "interview";
  return "replied";
}

function header(msg: gmail_v1.Schema$Message, name: string) {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function plainText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return (part.parts ?? []).map(plainText).join("\n");
}

/** Strips quoted history ("On ... wrote:" and ">" lines) so our own sent email doesn't trigger keyword matches. */
function stripQuoted(text: string) {
  const cut = text.search(/^On .+wrote:$/m);
  return (cut >= 0 ? text.slice(0, cut) : text)
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n");
}

export interface ThreadReply {
  from: string;
  date: Date;
  snippet: string;
  text: string;
}

/** Returns messages in the thread sent by someone else after `since`. Bounces are ignored. */
export async function getThreadReplies(threadId: string, since: Date): Promise<ThreadReply[]> {
  const { gmail, email } = await getGmail();
  try {
    const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    return (res.data.messages ?? [])
      .map((m) => ({
        from: header(m, "From"),
        date: new Date(Number(m.internalDate ?? 0)),
        snippet: m.snippet ?? "",
        text: stripQuoted(plainText(m.payload)) || m.snippet || "",
      }))
      .filter(
        (m) =>
          m.date > since &&
          !m.from.toLowerCase().includes(email.toLowerCase()) &&
          !/mailer-daemon|postmaster/i.test(m.from),
      );
  } catch (err) {
    if ((err as { code?: number }).code === 404) return [];
    wrapGoogleError(err);
  }
}
