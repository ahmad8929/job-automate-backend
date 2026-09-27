import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// AES-256-GCM. Stored format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>
const key = Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex");

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Unrecognized encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Signed, expiring OAuth `state` values so the callback can't be forged (CSRF protection).
const STATE_TTL_MS = 10 * 60 * 1000;

function sign(value: string): string {
  return createHmac("sha256", key).update(`oauth-state:${value}`).digest("base64url");
}

export function createOAuthState(): string {
  const value = `${Date.now()}.${randomBytes(16).toString("base64url")}`;
  return `${value}.${sign(value)}`;
}

export function verifyOAuthState(state: string): boolean {
  const lastDot = state.lastIndexOf(".");
  if (lastDot < 0) return false;
  const value = state.slice(0, lastDot);
  if (!safeEqual(sign(value), state.slice(lastDot + 1))) return false;
  const issuedAt = Number(value.split(".")[0]);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt < STATE_TTL_MS;
}
