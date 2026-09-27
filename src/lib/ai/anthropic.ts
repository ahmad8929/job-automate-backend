import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config, HttpError, requireConfig } from "../../config.js";
import type { AIProvider, StructuredRequest } from "./types.js";

let client: Anthropic | null = null;

export const anthropicProvider: AIProvider = {
  name: "anthropic",
  label: "Claude",
  isConfigured: () => Boolean(config.ANTHROPIC_API_KEY),

  async parse<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    client ??= new Anthropic({ apiKey: requireConfig("ANTHROPIC_API_KEY") });
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (req.image) {
      content.push({ type: "image", source: { type: "base64", media_type: req.image.mime, data: req.image.data.toString("base64") } });
    }
    content.push({ type: "text", text: req.text });
    try {
      const response = await client.beta.messages.parse({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 16000,
        system: req.system,
        messages: [{ role: "user", content }],
        output_config: { format: betaZodOutputFormat(req.schema), ...(req.effort ? { effort: req.effort } : {}) },
        // Server-side refusal fallback: if a safety classifier declines, the API retries on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal") throw new HttpError(422, "Claude declined to process this content");
      if (response.stop_reason === "max_tokens" || !response.parsed_output) {
        throw new HttpError(502, "Claude returned an incomplete response, please retry");
      }
      return response.parsed_output as z.infer<T>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, "Anthropic API key is invalid");
      if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, "Claude rate limit hit, try again shortly");
      if (err instanceof Anthropic.BadRequestError) throw new HttpError(400, `Claude rejected the request: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude API error (${err.status})`);
      throw err;
    }
  },
};
