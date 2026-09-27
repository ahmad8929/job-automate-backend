import type { RequestHandler } from "express";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";

/** Every /api route (except the Google OAuth callback) requires the shared server-to-server key. */
export const requireApiKey: RequestHandler = (req, res, next) => {
  const key = req.header("x-api-key");
  if (!key || !safeEqual(key, config.BACKEND_API_KEY)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
