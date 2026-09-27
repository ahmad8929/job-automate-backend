import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { config, HttpError, requireConfig } from "../../config.js";
import type { AIProvider, StructuredRequest } from "./types.js";

let client: OpenAI | null = null;

export const openaiProvider: AIProvider = {
  name: "openai",
  label: "ChatGPT",
  isConfigured: () => Boolean(config.OPENAI_API_KEY),

  async parse<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    client ??= new OpenAI({ apiKey: requireConfig("OPENAI_API_KEY") });
    const content: OpenAI.Responses.ResponseInputContent[] = [];
    if (req.image) {
      content.push({
        type: "input_image",
        detail: "high", // screenshots have small text (emails in comments)
        image_url: `data:${req.image.mime};base64,${req.image.data.toString("base64")}`,
      });
    }
    content.push({ type: "input_text", text: req.text });
    try {
      const response = await client.responses.parse({
        model: config.OPENAI_MODEL,
        instructions: req.system,
        input: [{ role: "user", content }],
        text: { format: zodTextFormat(req.schema, req.schemaName) },
        ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
      });
      if (!response.output_parsed) {
        throw new HttpError(502, "ChatGPT returned an incomplete or refused response, please retry");
      }
      return response.output_parsed as z.infer<T>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof OpenAI.AuthenticationError) throw new HttpError(503, "OpenAI API key is invalid");
      if (err instanceof OpenAI.RateLimitError) throw new HttpError(429, "OpenAI rate limit or quota hit (check billing), try again shortly");
      if (err instanceof OpenAI.BadRequestError) throw new HttpError(400, `OpenAI rejected the request: ${err.message}`);
      if (err instanceof OpenAI.APIError) throw new HttpError(502, `OpenAI API error (${err.status})`);
      throw err;
    }
  },
};
