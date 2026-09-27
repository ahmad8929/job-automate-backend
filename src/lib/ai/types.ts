import type { z } from "zod";

export type ProviderName = "anthropic" | "openai" | "gemini";
export type ProviderChoice = ProviderName | "auto";
export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface StructuredRequest<T extends z.ZodType> {
  schema: T;
  schemaName: string;
  system: string;
  text: string;
  image?: { data: Buffer; mime: ImageType };
  effort?: "low" | "medium" | "high";
}

export interface AIProvider {
  name: ProviderName;
  label: string;
  isConfigured(): boolean;
  parse<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}
