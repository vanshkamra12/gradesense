import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import type { GradeProvider, PromptPart } from "./provider.js";

/** Status codes worth one more attempt: rate limits and server-side faults. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1500;

export function isTransientFailure(error: unknown): boolean {
  const status = (error as { status?: number; code?: number })?.status
    ?? (error as { code?: number })?.code;
  if (typeof status === "number" && TRANSIENT.has(status)) return true;

  // The SDK stringifies HTTP failures, and network faults arrive as codes.
  const message = error instanceof Error ? error.message : String(error);
  return /\b(408|429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(message);
}

/**
 * The prompt is already an ordered list of parts, so this is a direct mapping
 * onto Gemini's own shape - text stays text, a PNG becomes inline base64 data,
 * and the order is preserved exactly as the prompt builder set it.
 */
export function toGeminiParts(parts: PromptPart[]) {
  return parts.map((part) =>
    part.kind === "text"
      ? { text: part.text }
      : { inlineData: { mimeType: "image/png", data: part.png.toString("base64") } },
  );
}

export type GeminiOptions = {
  apiKey?: string;
  model?: string;
  /** Point at a stub endpoint to exercise this provider without the network. */
  baseUrl?: string;
};

export function geminiProvider(options: GeminiOptions = {}): GradeProvider {
  const apiKey = options.apiKey ?? config.geminiApiKey;
  const model = options.model ?? config.geminiModel;
  const baseUrl = options.baseUrl ?? config.geminiBaseUrl;

  if (apiKey === "") {
    throw new Error("GEMINI_API_KEY is not set; set it in server/.env or use GRADE_PROVIDER=mock");
  }

  const client = new GoogleGenAI({
    apiKey,
    ...(baseUrl === "" ? {} : { httpOptions: { baseUrl } }),
  });

  return {
    name: `gemini:${model}`,

    async grade({ parts }) {
      const request = {
        model,
        contents: [{ role: "user" as const, parts: toGeminiParts(parts) }],
        config: {
          // Asking for JSON directly, on top of the prompt's own instruction.
          responseMimeType: "application/json",
          // Marking should not wander between runs any more than it has to.
          temperature: 0,
        },
      };

      const call = async () => {
        const response = await client.models.generateContent(request);
        const text = response.text;
        if (text === undefined || text.trim() === "") {
          throw new Error(
            `the model returned no text (finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"})`,
          );
        }
        return text;
      };

      try {
        return await call();
      } catch (error) {
        // One retry, and only for a failure worth retrying. A malformed answer
        // is handled by the pipeline's repair attempt, not here.
        if (!isTransientFailure(error)) throw error;

        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        try {
          return await call();
        } catch (retryError) {
          const message = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`Gemini failed twice: ${message}`);
        }
      }
    },
  };
}
