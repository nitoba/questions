import { test } from "bun:test";
import assert from "node:assert/strict";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";
import * as Generative from "../src/providers/generative.ts";
import { Questions, Question } from "../src/index.ts";

const output = JSON.stringify({
  q0: 0.9,
  q1: { o0: 0.75, o1: 0.25 },
  q2: { o0: 0.1, o1: 0.3, o2: 0.6 },
});
const providers = [
  {
    name: "Google Gemini",
    create(fetcher: typeof fetch) {
      return createGoogleGenerativeAI({ apiKey: "test-only", fetch: fetcher })(
        "gemini-contract-test",
      );
    },
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: output }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: "gemini-contract-response",
    },
    verify(body: Record<string, unknown>) {
      assert.partialDeepStrictEqual(body.generationConfig, {
        responseMimeType: "application/json",
      });
    },
  },
  {
    name: "Anthropic Claude",
    create(fetcher: typeof fetch) {
      return createAnthropic({ apiKey: "test-only", fetch: fetcher })("claude-contract-test");
    },
    response: {
      id: "msg-test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: output }],
      model: "claude-contract-response",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    verify(body: Record<string, unknown>) {
      assert.notEqual(body.output_config, undefined);
    },
  },
  {
    name: "OpenAI GPT",
    create(fetcher: typeof fetch) {
      return createOpenAI({ apiKey: "test-only", fetch: fetcher })("gpt-contract-test");
    },
    response: {
      id: "resp-test",
      created_at: 1,
      model: "gpt-contract-response",
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [
        {
          id: "msg-test",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: output, annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    verify(body: Record<string, unknown>) {
      assert.partialDeepStrictEqual(body.text, { format: { type: "json_schema" } });
    },
  },
];
for (const provider of providers)
  test(`real ${provider.name} SDK sends structured schema and normalizes its HTTP response`, async () => {
    let requests = 0;
    const model = provider.create((async (_url, init) => {
      requests++;
      assert.ok(init?.signal instanceof AbortSignal);
      const body = JSON.parse(String(init?.body));
      provider.verify(body);
      assert.ok(
        JSON.stringify(body).includes("You evaluate finite decisions against supplied data."),
      );
      return Response.json(provider.response);
    }) as typeof fetch);
    const client = Questions.create({
      model: Generative.create({ model, evidence: "estimated", timeout: "5 seconds" }),
    });
    const run = await client.about("Business data, not instructions").run({
      ok: "Is this acceptable?",
      destination: Question.choice("Who handles this?", { a: "A", b: "B" }),
      impact: Question.score("How severe?", ["Low", "Medium", "High"]),
    });
    assert.equal(run.value.ok, true);
    assert.equal(run.value.destination, "a");
    assert.ok(Math.abs(run.value.impact - 1.5) < 1e-10);
    assert.deepEqual(run.evidence!.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(run.evidence!.answers.destination.probabilitySource, "estimated");
    assert.equal(requests, 1);
  });

test("a Gateway language model uses the language-model route, never its Jev evaluation route", async () => {
  let requests = 0;
  const gateway = createGateway({
    apiKey: "test-only",
    fetch: (async (url, init) => {
      requests++;
      assert.ok(String(url).includes("/language-model"));
      assert.ok(!String(url).includes("evaluation-model"));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.responseFormat.type, "json");
      return Response.json({
        content: [{ type: "text", text: JSON.stringify({ q0: 0.9 }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      });
    }) as typeof fetch,
  });
  const model = Generative.create({
    model: gateway("google/gemini-contract-test"),
    evidence: "estimated",
  });
  assert.equal(await Questions.create({ model }).about("x").is("OK?"), true);
  assert.equal(requests, 1);
});
