import { test, expect } from "bun:test";
import { Questions } from "../../src/index.ts";
import { liveModel, languageModel, type Environment } from "../shared/runtime.ts";
import { comparisonModel } from "../11-preparation-and-replay.ts";

const output = JSON.stringify({ q0: 0.9 });
const providerCases = [
  {
    provider: "google",
    modelId: "gemini-contract-test",
    key: "GOOGLE_GENERATIVE_AI_API_KEY",
    route: "generateContent",
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: output }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
  },
  {
    provider: "anthropic",
    modelId: "claude-contract-test",
    key: "ANTHROPIC_API_KEY",
    route: "/messages",
    response: {
      id: "msg-test",
      type: "message",
      role: "assistant",
      model: "claude-contract-test",
      content: [{ type: "text", text: output }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    provider: "openai",
    modelId: "gpt-contract-test",
    key: "OPENAI_API_KEY",
    route: "/responses",
    response: {
      id: "resp-test",
      created_at: 1,
      model: "gpt-contract-test",
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
  },
  {
    provider: "gateway",
    modelId: "google/gemini-contract-test",
    key: "AI_GATEWAY_API_KEY",
    route: "/language-model",
    response: {
      content: [{ type: "text", text: output }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
      warnings: [],
    },
  },
] as const;

for (const item of providerCases) {
  test(`example selector: ${item.provider} uses its real SDK and marks estimated evidence`, async () => {
    let calls = 0;
    const model = await liveModel(
      {
        QUESTIONS_PROVIDER: "generative",
        GENERATIVE_PROVIDER: item.provider,
        GENERATIVE_MODEL: item.modelId,
        [item.key]: "test-only-key",
        EXAMPLE_TIMEOUT: "5 s",
      },
      (async (url, init) => {
        calls++;
        expect(String(url)).toContain(item.route);
        expect(String(url)).not.toContain("/evaluation-model");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json(item.response);
      }) as typeof fetch,
    );
    expect(calls).toBe(0); // Configuration never evaluates the model.
    const result = await Questions.create({ model }).about("Fictional incident").run({ ok: "OK?" });
    expect(result.value).toEqual({ ok: true });
    expect(result.evidence?.answers.ok.probabilitySource).toBe("estimated");
    expect(result.evidence?.providerMetadata?.questionsGenerative?.requestedModel).toBe(
      item.modelId,
    );
    expect(calls).toBe(1);
  });
}

test("example selector: native defaults do not switch just because generative variables exist", async () => {
  let calls = 0;
  const model = await liveModel(
    {
      TYPESAFE_API_KEY: "test-only",
      GENERATIVE_PROVIDER: "invalid-but-unused",
    },
    (async (url, init) => {
      calls++;
      expect(String(url)).toContain("/systemone");
      const request = JSON.parse(String(init?.body));
      return Response.json({
        model: "native-test",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
        ),
      });
    }) as typeof fetch,
  );
  const run = await Questions.create({ model }).about("x").run({ ok: "OK?" });
  expect(run.evidence?.answers.ok.probabilitySource).toBe("provider");
  expect(calls).toBe(1);
});

test("example selector: unknown modes, blank credentials and missing model IDs fail without fallback", async () => {
  const valid = {
    QUESTIONS_PROVIDER: "generative",
    GENERATIVE_PROVIDER: "google",
    GENERATIVE_MODEL: "test-only-model",
  };
  const cases: readonly Environment[] = [
    { QUESTIONS_PROVIDER: "invalid" },
    { QUESTIONS_PROVIDER: "generative" },
    { ...valid, GENERATIVE_PROVIDER: "invalid" },
    { ...valid, GENERATIVE_MODEL: "" },
    { ...valid, GENERATIVE_MODEL: "  " },
    { ...valid },
    { ...valid, GOOGLE_GENERATIVE_AI_API_KEY: "  " },
  ];
  let calls = 0;
  const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    calls++;
    throw new Error("No HTTP expected");
  }) as typeof fetch;
  for (const env of cases) await expect(liveModel(env, fetcher)).rejects.toThrow("Set ");
  expect(calls).toBe(0);
  await expect(
    liveModel({ ...valid, EXAMPLE_TIMEOUT: "not a duration" }, fetcher),
  ).rejects.toThrow();
});

test("language model configuration requires the chosen provider's key, not a different vendor's key", async () => {
  await expect(
    languageModel({
      GENERATIVE_PROVIDER: "anthropic",
      GENERATIVE_MODEL: "test",
      GOOGLE_GENERATIVE_AI_API_KEY: "unused",
    }),
  ).rejects.toThrow("Set ANTHROPIC_API_KEY");
  await expect(
    languageModel({
      GENERATIVE_PROVIDER: "gateway",
      GENERATIVE_MODEL: "test",
      OPENAI_API_KEY: "unused",
    }),
  ).rejects.toThrow("Set AI_GATEWAY_API_KEY");
});

test("replay comparison is disabled by default and validates its own generative target", async () => {
  expect(await comparisonModel({})).toBeUndefined();
  expect(await comparisonModel({ COMPARE_WITH_VERCEL: "0" })).toBeUndefined();
  await expect(comparisonModel({ COMPARE_PROVIDER: "unknown" })).rejects.toThrow(
    "Set COMPARE_PROVIDER",
  );
  await expect(
    comparisonModel({
      COMPARE_PROVIDER: "generative",
      GENERATIVE_PROVIDER: "google",
      GENERATIVE_MODEL: "primary-only",
    }),
  ).rejects.toThrow("COMPARE_GENERATIVE_PROVIDER");
  await expect(
    comparisonModel({ COMPARE_PROVIDER: "vercel", COMPARE_WITH_VERCEL: "1" }),
  ).rejects.toThrow("Set only");
  const env = Object.freeze({
    COMPARE_PROVIDER: "generative",
    COMPARE_GENERATIVE_PROVIDER: "anthropic",
    COMPARE_GENERATIVE_MODEL: "alternative-test",
    GENERATIVE_PROVIDER: "google",
    GENERATIVE_MODEL: "primary-test",
    ANTHROPIC_API_KEY: "test-only",
  });
  expect(typeof (await comparisonModel(env))?.evaluate).toBe("function");
  expect(env.GENERATIVE_MODEL).toBe("primary-test");
  expect(
    (await comparisonModel({ COMPARE_WITH_VERCEL: "1", AI_GATEWAY_API_KEY: "test-only" }))?.name,
  ).toBeDefined();
});
