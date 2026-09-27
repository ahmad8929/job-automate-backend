import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { sql } from "./db/client.js";
import { requireApiKey } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errors.js";
import { applicationsRouter } from "./routes/applications.js";
import { chatgptRouter } from "./routes/chatgpt.js";
import { composeRouter } from "./routes/compose.js";
import { draftRouter } from "./routes/draft.js";
import { extractRouter } from "./routes/extract.js";
import { gmailRouter } from "./routes/gmail.js";
import { oauthRouter } from "./routes/oauth.js";
import { profileRouter } from "./routes/profile.js";
import { sendRouter } from "./routes/send.js";
import { listProviders } from "./lib/ai/index.js";

const app = express();

// Behind Nginx on the VPS: trust one proxy hop so rate limiting sees the real client IP.
if (config.NODE_ENV === "production") app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Allow server-to-server requests (no Origin header) and whitelisted origins only
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }));

// Tighter limit on the endpoints that cost money (Claude calls).
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, message: { error: "Too many AI requests, slow down" } });

app.get("/health", async (_req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ ok: true, db: "connected" });
  } catch {
    res.status(500).json({ ok: false, db: "error" });
  }
});

app.use("/api/oauth", oauthRouter); // callback is public; the rest check the API key inside the router
app.use("/api", requireApiKey);
app.use("/api/compose", aiLimiter, composeRouter);
app.use("/api/extract", aiLimiter, extractRouter);
app.use("/api/draft", aiLimiter, draftRouter);
app.use("/api/send", sendRouter);
app.use("/api/applications", applicationsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/gmail", gmailRouter);
app.use("/api/chatgpt", chatgptRouter);
app.get("/api/ai/providers", (_req, res) => {
  res.json(listProviders());
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

app.listen(config.PORT, () => {
  console.log(`Backend listening on http://localhost:${config.PORT}`);
});
