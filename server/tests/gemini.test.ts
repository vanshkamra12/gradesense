import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { geminiProvider, isTransientFailure, toGeminiParts } from "../src/grade/gemini.js";
import type { PromptPart } from "../src/grade/provider.js";

const PARTS: PromptPart[] = [
  { kind: "text", text: "marking material and the student's answer" },
  { kind: "image", png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  { kind: "image", png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]) },
  { kind: "text", text: "the output contract" },
];

describe("mapping prompt parts onto Gemini's shape", () => {
  it("keeps the order and turns images into inline base64 data", () => {
    const mapped = toGeminiParts(PARTS);

    expect(mapped).toHaveLength(4);
    expect(mapped[0]).toEqual({ text: "marking material and the student's answer" });
    expect(mapped[3]).toEqual({ text: "the output contract" });

    for (const index of [1, 2]) {
      const part = mapped[index] as { inlineData: { mimeType: string; data: string } };
      expect(part.inlineData.mimeType).toBe("image/png");
      expect(Buffer.from(part.inlineData.data, "base64").subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    }

    // The images sit between the two text parts, as the prompt builder set them.
    expect(mapped.map((p) => ("text" in p ? "text" : "image"))).toEqual([
      "text",
      "image",
      "image",
      "text",
    ]);
  });
});

describe("which failures are worth retrying", () => {
  it("retries rate limits and server faults", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isTransientFailure({ status })).toBe(true);
      expect(isTransientFailure(new Error(`{"error":{"code":${status}}}`))).toBe(true);
    }
    expect(isTransientFailure(new Error("fetch failed"))).toBe(true);
    expect(isTransientFailure(new Error("read ECONNRESET"))).toBe(true);
  });

  it("does not retry a refusal, a bad request or a missing model", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isTransientFailure({ status })).toBe(false);
      expect(isTransientFailure(new Error(`{"error":{"code":${status}}}`))).toBe(false);
    }
  });
});

/**
 * The provider pointed at a local stub of the Gemini endpoint. This verifies
 * everything about the integration except the model's own answers: the request
 * shape, the ordering of parts, the JSON and temperature settings, the retry,
 * and the errors. Grading quality is a separate question that only the real
 * API can answer.
 */
describe("the provider against a stub endpoint", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function stub(handler: (body: unknown, attempt: number) => { status: number; body: unknown }) {
    let attempt = 0;
    const seen: unknown[] = [];

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        seen.push(body);
        const reply = handler(body, attempt++);
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server!.address() as AddressInfo;

    const provider = geminiProvider({
      apiKey: "stub-key",
      model: "stub-model",
      baseUrl: `http://127.0.0.1:${port}`,
    });
    return { provider, seen };
  }

  const answer = (text: string) => ({
    status: 200,
    body: { candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }] },
  });

  it("sends the parts in order, asks for JSON, and returns the text", async () => {
    const { provider, seen } = await stub(() => answer('{"criteria":[]}'));

    const result = await provider.grade({ parts: PARTS });
    expect(result).toBe('{"criteria":[]}');

    const request = seen[0] as {
      contents: { parts: unknown[] }[];
      generationConfig?: { responseMimeType?: string; temperature?: number };
    };

    const sent = request.contents[0]!.parts;
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual({ text: PARTS[0]!.kind === "text" ? PARTS[0]!.text : "" });
    expect(sent[1]).toHaveProperty("inlineData");
    expect(sent[2]).toHaveProperty("inlineData");
    expect(sent[3]).toHaveProperty("text");

    expect(request.generationConfig?.responseMimeType).toBe("application/json");
    expect(request.generationConfig?.temperature).toBe(0);
  }, 30_000);

  it("retries once on a transient failure and succeeds", async () => {
    const { provider, seen } = await stub((_body, attempt) =>
      attempt === 0
        ? { status: 503, body: { error: { code: 503, message: "overloaded" } } }
        : answer('{"criteria":[{"ok":true}]}'),
    );

    expect(await provider.grade({ parts: PARTS })).toContain("ok");
    expect(seen).toHaveLength(2);
  }, 30_000);

  it("does not retry a permanent failure", async () => {
    const { provider, seen } = await stub(() => ({
      status: 403,
      body: { error: { code: 403, message: "denied" } },
    }));

    await expect(provider.grade({ parts: PARTS })).rejects.toThrow(/403|denied/);
    expect(seen).toHaveLength(1);
  }, 30_000);

  it("fails cleanly when both attempts fail", async () => {
    const { provider, seen } = await stub(() => ({
      status: 429,
      body: { error: { code: 429, message: "quota exhausted" } },
    }));

    await expect(provider.grade({ parts: PARTS })).rejects.toThrow(/Gemini failed twice/);
    expect(seen).toHaveLength(2);
  }, 30_000);

  it("treats an empty response as an error rather than as an answer", async () => {
    const { provider } = await stub(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [], role: "model" }, finishReason: "MAX_TOKENS" }] },
    }));

    await expect(provider.grade({ parts: PARTS })).rejects.toThrow(/no text|MAX_TOKENS/);
  }, 30_000);
});
