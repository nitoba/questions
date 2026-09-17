import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Jev, Question, Questions, ProviderError, TimeoutError, ValidationError } from "../src/index.ts";
import { deferred, tick } from "./helpers.ts";

const wire = { model: "jev-test", usage: { input_tokens: 12, output_tokens: 2 },
  answers: { answer: { type: "noul", noul: 0.95 } } };
const fetcher = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => handler as typeof globalThis.fetch;
const client = (options: Partial<Jev.Options> = {}) => Questions.create({ model: Jev.create({ apiKey: "test-key", ...options }) });

test("Jev request matches documented endpoint, headers, noul and usage protocol", async () => {
  let calls = 0;
  const q = client({ fetch: fetcher(async (input, init) => {
    calls++;
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.questions.answer.type, "noul");
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(body.state, { issue: "Blocked" });
    return Response.json(wire);
  }) });
  const result = await q.about({ issue: "Blocked" }).evidence({ answer: "Blocked?" });
  assert.equal(result.answers.answer.probability, 0.95);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 2 });
  assert.equal(calls, 1);
});

test("structured option descriptions are encoded as text and criteria limits precede fetch", async () => {
  let called = 0;
  const q = client({ fetch: fetcher(async (_, init) => {
    called++; const body = JSON.parse(String(init?.body));
    assert.equal(body.questions.route.criteria.a, '{"description":"A"}');
    return Response.json({ ...wire, answers: { route: { type: "choice", choice: "a", probabilities: { a: 1, b: 0 }, confidence: 1 } } });
  }) });
  assert.equal((await q.about("x").ask({ route: Question.choice("Route?", { a: { description: "A" }, b: null }) })).route, "a");
  const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), "Option"]));
  await assert.rejects(q.about("x").ask({ route: Question.choice("Route?", criteria) }), ValidationError);
  assert.equal(called, 1);
});

test("429 does not retry unless requested and response bodies are not leaked in errors", async () => {
  let called = 0;
  const q = client({ fetch: fetcher(async () => { called++; return new Response("secret-provider-body", { status: 429 }); }) });
  await assert.rejects(q.about("x").is("OK?"), (error) => error instanceof ProviderError && error.status === 429
    && !JSON.stringify(error).includes("secret-provider-body") && !String(error).includes("test-key"));
  assert.equal(called, 1);
});

test("opt-in 429/529 retries reuse identical request bytes", async () => {
  const bodies: string[] = [];
  const q = client({ retry: { maxRetries: 2, initialDelayMs: 0, jitter: false }, fetch: fetcher(async (_, init) => {
    bodies.push(String(init?.body));
    return bodies.length < 3 ? new Response("busy", { status: bodies.length === 1 ? 429 : 529 }) : Response.json(wire);
  }) });
  assert.equal(await q.about("x").is("OK?"), true);
  assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
});

test("authentication, server and network failures are not retried", async () => {
  for (const status of [401, 403, 500]) {
    let called = 0;
    const q = client({ retry: { maxRetries: 2 }, fetch: fetcher(async () => { called++; return new Response("bad", { status }); }) });
    await assert.rejects(q.about("x").is("OK?"), ProviderError); assert.equal(called, 1);
  }
  let called = 0; const cause = new Error("network");
  const q = client({ retry: { maxRetries: 2 }, fetch: fetcher(async () => { called++; throw cause; }) });
  await assert.rejects(q.about("x").is("OK?"), (error) => error instanceof ProviderError && error.kind === "network" && error.cause === cause);
  assert.equal(called, 1);
});

test("Retry-After above budget stops retries instead of shortening server delay", async () => {
  let called = 0;
  const q = client({ retry: { maxRetries: 2, maxDelayMs: 20 }, fetch: fetcher(async () => {
    called++; return new Response("busy", { status: 429, headers: { "retry-after": "10" } });
  }) });
  await assert.rejects(q.about("x").is("OK?"), ProviderError); assert.equal(called, 1);
});

test("Retry-After is a minimum delay", async () => {
  const times: number[] = [];
  const q = client({ retry: { maxRetries: 1, initialDelayMs: 0, jitter: false }, fetch: fetcher(async () => {
    times.push(performance.now());
    return times.length === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "0.04" } }) : Response.json(wire);
  }) });
  await q.about("x").is("OK?");
  assert.ok(times[1]! - times[0]! >= 35);
});

test("total timeout interrupts fetch and preserves TimeoutError", async () => {
  let signal: AbortSignal | null | undefined;
  const q = client({ timeoutMs: 10, fetch: fetcher(async (_, init) => {
    signal = init?.signal; return new Promise<Response>(() => {});
  }) });
  await assert.rejects(q.about("x").is("OK?"), TimeoutError);
  assert.equal(signal?.aborted, true);
});

test("timeout covers retries and does not start another request", async () => {
  let called = 0;
  const q = client({ timeoutMs: 10, retry: { maxRetries: 2, initialDelayMs: 100, jitter: false }, fetch: fetcher(async () => {
    called++; return new Response("busy", { status: 429 });
  }) });
  await assert.rejects(q.about("x").is("OK?"), TimeoutError);
  assert.equal(called, 1);
});

test("timeout covers response body reading and cancels the reader", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const q = client({ timeoutMs: 10, fetch: fetcher(async () => new Response(body)) });
  await assert.rejects(q.about("x").is("OK?"), TimeoutError);
  assert.equal(canceled, true); assert.equal(body.locked, false);
});

test("late response from a noncooperative fetch is canceled after abort", async () => {
  const pending = deferred<Response>(); const controller = new AbortController();
  const q = client({ fetch: fetcher(() => pending.promise) });
  const result = q.about("x").is("OK?", { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(result);
  let canceled = false;
  pending.resolve(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await tick(); assert.equal(canceled, true);
});

test("response byte limits enforce actual streamed bytes and release the body", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(20)); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  const q = client({ maxResponseBytes: 10, fetch: fetcher(async () => new Response(body)) });
  await assert.rejects(q.about("x").is("OK?"), (error) => error instanceof ProviderError && error.kind === "response");
  assert.equal(canceled, true); assert.equal(body.locked, false);
});

test("incremental UTF-8 decoder handles multi-byte characters split across chunks", async () => {
  const data = new TextEncoder().encode(JSON.stringify({ ...wire, model: "jev-ação" }));
  const body = new ReadableStream<Uint8Array>({ start(c) {
    for (const byte of data) c.enqueue(Uint8Array.of(byte)); c.close();
  } });
  const q = client({ fetch: fetcher(async () => new Response(body)) });
  assert.equal((await q.about("x").evidence({ answer: "OK?" })).model, "jev-ação");
});

test("malformed JSON and invalid UTF-8 are response failures without retry", async () => {
  for (const data of ["not-json", new Uint8Array([255])]) {
    let called = 0;
    const q = client({ retry: { maxRetries: 2 }, fetch: fetcher(async () => { called++; return new Response(data); }) });
    await assert.rejects(q.about("x").is("OK?"), (error) => error instanceof ProviderError && error.kind === "response");
    assert.equal(called, 1);
  }
});

test("configuration validation is eager and returned model does not expose credentials", () => {
  assert.throws(() => Jev.create({ apiKey: "" }), ValidationError);
  assert.throws(() => Jev.create({ apiKey: "x", baseUrl: "file:///tmp" }), ValidationError);
  assert.throws(() => Jev.create({ apiKey: "x", baseUrl: "https://user:pass@example.com/v1" }), ValidationError);
  assert.throws(() => Jev.create({ apiKey: "x", retry: { maxRetries: 11 } }), ValidationError);
  assert.throws(() => Jev.create({ apiKey: "x", timeoutMs: 0 }), ValidationError);
  assert.equal(JSON.stringify(Jev.create({ apiKey: "very-private" })).includes("very-private"), false);
});

test("real fetch round-trip against an in-process HTTP server", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer test-key");
    let body = ""; request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      assert.equal(JSON.parse(body).questions.answer.type, "noul");
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(wire));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    assert.equal(await client({ baseUrl: `http://127.0.0.1:${port}/v1` }).about("x").is("OK?"), true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
