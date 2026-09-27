import { Router } from "express";
import { config, HttpError } from "../config.js";
import { verifyOAuthState } from "../lib/crypto.js";
import { disconnect, getAuthUrl, getConnectionStatus, handleOAuthCallback } from "../lib/gmail.js";
import { requireApiKey } from "../middleware/auth.js";

export const oauthRouter = Router();

/** POST /api/oauth/google — returns the Google consent URL to redirect the browser to. */
oauthRouter.post("/google", requireApiKey, (_req, res) => {
  res.json({ url: getAuthUrl() });
});

oauthRouter.get("/google/status", requireApiKey, async (_req, res) => {
  res.json(await getConnectionStatus());
});

oauthRouter.delete("/google", requireApiKey, async (_req, res) => {
  await disconnect();
  res.json({ ok: true });
});

/**
 * GET /api/oauth/google/callback — Google redirects the browser here (public route, protected by signed `state`).
 * Always ends by redirecting back to the frontend Profile page with a result flag.
 */
oauthRouter.get("/google/callback", async (req, res) => {
  const back = new URL("/profile", config.FRONTEND_URL);
  try {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) throw new HttpError(400, `Google returned: ${error}`);
    if (!state || !verifyOAuthState(state)) throw new HttpError(400, "Invalid or expired OAuth state, please try again");
    if (!code) throw new HttpError(400, "Missing authorization code");
    await handleOAuthCallback(code);
    back.searchParams.set("gmail", "connected");
  } catch (err) {
    console.error("OAuth callback failed:", err);
    back.searchParams.set("gmail", "error");
    back.searchParams.set("message", err instanceof HttpError ? err.message : "Connection failed");
  }
  res.redirect(back.toString());
});
