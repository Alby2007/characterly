import OpenAI from "openai";
import { config } from "./config.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

/** Text embeddings for semantic recall. Any OpenAI-compatible /embeddings
 * endpoint works — local Ollama (`http://127.0.0.1:11434/v1`, `all-minilm`),
 * OpenAI, vLLM, LM Studio. The URL is operator-configured, not model-decided,
 * so it does NOT route through guardedLlmFetch (localhost is a legitimate
 * target here — the SSRF guard exists for tool URLs).
 *
 * The whole feature is opt-in: no EMBED_BASE_URL → enabled=false, embed()
 * returns null, and every caller degrades to the lexical recall legs. */
export interface Embedder {
  readonly enabled: boolean;
  embed(text: string): Promise<number[] | null>;
}

export interface EmbedderConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  dims: number;
  /** Per-call timeout so a dead endpoint can't stall the job queue. */
  timeoutMs: number;
}

export function makeEmbedder(opts: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dims?: number;
  timeoutMs?: number;
  client?: OpenAI;
}): Embedder {
  const { baseUrl, apiKey = "ollama", model = "all-minilm", dims = 384, timeoutMs = 4_000 } = opts;
  if (!baseUrl) return { enabled: false, embed: async () => null };
  const client = opts.client ?? new OpenAI({ apiKey, baseURL: baseUrl, timeout: timeoutMs });
  let warned = false;
  const warnOnce = (msg: string, e?: unknown) => {
    if (warned) return;
    warned = true;
    inc("embed.error");
    logError(msg, e);
  };
  return {
    enabled: true,
    async embed(text: string): Promise<number[] | null> {
      const trimmed = text.trim();
      if (!trimmed) return null;
      try {
        const res = await client.embeddings.create({ model, input: trimmed.slice(0, 2048) });
        const vec = res.data?.[0]?.embedding;
        if (!Array.isArray(vec) || !vec.length) {
          warnOnce("embedding endpoint returned no vector");
          return null;
        }
        // Dim mismatch = wrong EMBED_MODEL for the column expectations.
        // Skip rather than store garbage — the vector column is un-dimensioned
        // and Postgres can't catch a semantic-model mismatch for us.
        if (vec.length !== dims) {
          warnOnce(`embedding dims ${vec.length} ≠ EMBED_DIMS ${dims} — check EMBED_MODEL`);
          return null;
        }
        if (!vec.every(Number.isFinite)) {
          warnOnce("embedding vector contained non-finite values");
          return null;
        }
        return vec;
      } catch (e) {
        warnOnce("embedding request failed", e);
        return null;
      }
    },
  };
}

let defaultInstance: Embedder | null = null;
export function defaultEmbedder(): Embedder {
  return (defaultInstance ??= makeEmbedder({
    baseUrl: config.embedBaseUrl,
    apiKey: config.embedApiKey,
    model: config.embedModel,
    dims: config.embedDims,
  }));
}

/** Serialize a JS vector for postgres.js — pgvector accepts the `[1,2,3]`
 * literal form via an explicit ::vector cast. */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
