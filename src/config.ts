import "dotenv/config";
import { z } from "zod";

// Empty values in .env ("KEY=") count as not set.
const optional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  // Comma-separated list of allowed origins, e.g. "http://localhost:3000,https://myapp.vercel.app"
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  // Where the Gmail OAuth callback sends you back to when it's done
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  // Shared secret the Next.js server sends in x-api-key; the browser never sees it
  BACKEND_API_KEY: z.string().min(32, "BACKEND_API_KEY must be at least 32 chars"),
  // 32-byte key, hex encoded (64 hex chars), used for AES-256-GCM token encryption
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "TOKEN_ENCRYPTION_KEY must be 64 hex chars"),
  // The only Gmail account allowed to be connected
  ALLOWED_EMAIL: z.string().email(),

  // Feature keys — optional so the server can boot before every integration is set up.
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: z.string().default("gpt-5.5"),
  // Free key from aistudio.google.com
  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  // Used if GEMINI_MODEL stays overloaded after retries. Empty = no fallback model.
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-flash-lite-latest"),
  // Which provider "Auto" tries first; the others are fallbacks (only ones with a key are used).
  AI_PROVIDER: z.enum(["anthropic", "openai", "gemini"]).default("gemini"),
  CLOUDINARY_URL: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:4000/api/oauth/google/callback"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
};

/** Throws a 503-style error when an integration is used before its keys are configured. */
export function requireConfig<K extends keyof typeof config>(key: K): NonNullable<(typeof config)[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === "") {
    throw new HttpError(503, `${String(key)} is not configured on the backend`);
  }
  return value as NonNullable<(typeof config)[K]>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
