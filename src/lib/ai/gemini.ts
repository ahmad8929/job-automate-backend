import { ApiError, GoogleGenAI, type Part } from "@google/genai";
import { z } from "zod";
import { config, HttpError, requireConfig } from "../../config.js";
import type { AIProvider, StructuredRequest } from "./types.js";

let client: GoogleGenAI | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Gemini often returns 503 "high demand": switch to the lighter model right away, then retry both once.
const PAUSE_BEFORE_ATTEMPT_MS = [0, 0, 2000, 0];
const isTransient = (err: unknown) => err instanceof ApiError && (err.status === 503 || err.status === 500 || err.status === 504);

export const geminiProvider: AIProvider = {
  name: "gemini",
  label: "Gemini",
  isConfigured: () => Boolean(config.GEMINI_API_KEY),

  async parse<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    client ??= new GoogleGenAI({ apiKey: requireConfig("GEMINI_API_KEY") });
    const parts: Part[] = [];
    if (req.image) parts.push({ inlineData: { mimeType: req.image.mime, data: req.image.data.toString("base64") } });
    parts.push({ text: req.text });
    const call = (model: string) =>
      client!.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(req.schema),
        },
      });
    const round = [config.GEMINI_MODEL, ...(config.GEMINI_FALLBACK_MODEL ? [config.GEMINI_FALLBACK_MODEL] : [])];
    const attempts = [...round, ...round];
    try {
      let response;
      for (let i = 0; ; i++) {
        try {
          response = await call(attempts[i]);
          break;
        } catch (err) {
          if (!isTransient(err) || i === attempts.length - 1) throw err;
          console.warn(`[gemini] ${attempts[i]} busy, trying ${attempts[i + 1]}…`);
          await sleep(PAUSE_BEFORE_ATTEMPT_MS[i + 1] ?? 1000);
        }
      }
      const text = response.text;
      if (!text) throw new HttpError(502, "Gemini returned an empty or blocked response, please retry");
      const parsed = req.schema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new HttpError(502, "Gemini returned data in an unexpected shape, please retry");
      return parsed.data as z.infer<T>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof SyntaxError) throw new HttpError(502, "Gemini returned invalid JSON, please retry");
      if (err instanceof ApiError) {
        if (err.status === 400 && /api key/i.test(err.message)) throw new HttpError(503, "Gemini API key is invalid");
        if (err.status === 401 || err.status === 403) throw new HttpError(503, "Gemini API key is invalid or lacks access");
        if (err.status === 404) throw new HttpError(503, `Gemini model "${config.GEMINI_MODEL}" not found — change GEMINI_MODEL`);
        if (err.status === 429) throw new HttpError(429, "Gemini free-tier limit reached, try again in a minute");
        if (isTransient(err)) throw new HttpError(503, "Gemini is overloaded right now, try again in a minute");
        throw new HttpError(502, `Gemini API error (${err.status})`);
      }
      throw err;
    }
  },
};
