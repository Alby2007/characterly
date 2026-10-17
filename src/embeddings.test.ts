import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import { makeEmbedder, vectorLiteral } from "./embeddings.js";

function fakeClient(embedding: number[] | Error, calls: Array<{ model: string; input: string }> = []): OpenAI {
  return {
    embeddings: {
      create: async (req: { model: string; input: string }) => {
        calls.push(req);
        if (embedding instanceof Error) throw embedding;
        return { data: [{ embedding }] };
      },
    },
  } as unknown as OpenAI;
}

test("embedder is disabled without a base URL — callers degrade to lexical legs", async () => {
  const e = makeEmbedder({});
  assert.equal(e.enabled, false);
  assert.equal(await e.embed("hello"), null);
});

test("embed returns the vector on success and forwards model + input", async () => {
  const calls: Array<{ model: string; input: string }> = [];
  const e = makeEmbedder({ baseUrl: "http://127.0.0.1:11434/v1", model: "all-minilm", dims: 3, client: fakeClient([0.1, 0.2, 0.3], calls) });
  assert.equal(e.enabled, true);
  const v = await e.embed("Biscuit's vet visit");
  assert.deepEqual(v, [0.1, 0.2, 0.3]);
  assert.equal(calls[0].model, "all-minilm");
  assert.equal(calls[0].input, "Biscuit's vet visit");
});

test("dim mismatch returns null — a wrong EMBED_MODEL can't poison the column", async () => {
  const e = makeEmbedder({ baseUrl: "http://x/v1", dims: 384, client: fakeClient([1, 2, 3]) });
  assert.equal(await e.embed("t"), null);
});

test("non-finite vectors and API errors degrade to null, never throw", async () => {
  const nan = makeEmbedder({ baseUrl: "http://x/v1", dims: 2, client: fakeClient([1, NaN]) });
  assert.equal(await nan.embed("t"), null);
  const down = makeEmbedder({ baseUrl: "http://x/v1", dims: 2, client: fakeClient(new Error("connection refused")) });
  assert.equal(await down.embed("t"), null);
});

test("blank input never reaches the endpoint", async () => {
  const calls: Array<{ model: string; input: string }> = [];
  const e = makeEmbedder({ baseUrl: "http://x/v1", dims: 3, client: fakeClient([1, 2, 3], calls) });
  assert.equal(await e.embed("   "), null);
  assert.equal(calls.length, 0);
});

test("vectorLiteral serializes the pgvector input form", () => {
  assert.equal(vectorLiteral([0.5, -1.25, 3]), "[0.5,-1.25,3]");
});
