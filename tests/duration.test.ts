import { test } from "bun:test";
import assert from "node:assert/strict";
import { Duration, Questions, TypeSafe, ValidationError, TimeoutError } from "../src/index.ts";
import * as Vercel from "../src/providers/vercel.ts";
import * as AISDK from "../src/providers/ai-sdk.ts";
import { deferred, tick } from "./helpers.ts";

const fetchOf = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  fn as typeof fetch;

test("duration parses fixed English units and explicit millis/milis aliases", () => {
  for (const [value, expected] of [
    [0, 0],
    [200, 200],
    ["1 ms", 1],
    ["200 milis", 200],
    ["200 millis", 200],
    ["1 s", 1000],
    ["10 seconds", 10000],
    ["2mins", 120000],
    ["1.5 hours", 5400000],
    [".5 s", 500],
    ["1 day", 86400000],
    ["1 WEEK", 604800000],
  ] as const)
    assert.equal(Duration.toMilliseconds(value), expected);
  assert.equal(Duration.parse("  1.5   SECONDS  "), 1500);
});

test("duration rejects ambiguous, misspelled, partial, unsafe and sub-ms values", () => {
  for (const value of [
    "200",
    "10 secods",
    "200 bananas",
    "1s garbage",
    "1s 200ms",
    "1 month",
    "1 year",
    "1e3s",
    "Infinity s",
    "-1 s",
    "",
    " ",
    "0.1 ms",
    "x".repeat(101),
    -1,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    0.01,
  ])
    assert.throws(() => Duration.parse(value), ValidationError);
});

for (const [name, create] of [
  ["TypeSafe", TypeSafe.create],
  ["Vercel", Vercel.create],
] as const) {
  test(`${name}: readable retry delays preserve stable bytes and report milliseconds`, async () => {
    let attempts = 0;
    const bodies: string[] = [],
      waits: number[] = [];
    const model = create({
      apiKey: "test",
      timeout: "1 second",
      retry: {
        maxRetries: 1,
        statusCodes: [503],
        initialDelay: "1 ms",
        maxDelay: "20 ms",
        delay: () => "2 milis",
      },
      hooks: {
        onRetry: (event) => {
          waits.push(event.delayMs);
        },
      },
      fetch: fetchOf(async (_url, init) => {
        attempts++;
        bodies.push(String(init?.body));
        if (attempts === 1) return new Response("retry", { status: 503 });
        const request = JSON.parse(String(init?.body));
        return Response.json({
          model: "test",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              name === "TypeSafe" ? { type: "noul", noul: 1 } : { type: "boolean", probability: 1 },
            ]),
          ),
        });
      }),
    });
    assert.equal(await Questions.create({ model }).about("x").is("Ready?"), true);
    assert.equal(attempts, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(waits, [2]);
  });
  test(`${name}: conflicting aliases and invalid duration policies fail before HTTP`, () => {
    const configs = [
      { timeout: "1 s", timeoutMs: 1000 },
      { timeout: "0 ms" },
      { timeout: "30 days" },
      { retry: { maxRetries: 1, initialDelay: "1 ms", initialDelayMs: 1 } },
      { retry: { maxRetries: 1, maxDelay: "1 s", maxDelayMs: 1000 } },
      { retry: { maxRetries: 1, delay: "1 s", delayMs: 1000 } },
      { retry: { maxRetries: 1, delay: "10 secods" } },
    ];
    for (const config of configs)
      assert.throws(
        () => create({ apiKey: "test", ...config } as Parameters<typeof create>[0]),
        ValidationError,
      );
  });
  test(`${name}: readable timeout bounds an uncooperative request`, async () => {
    const late = deferred<Response>();
    const model = create({ apiKey: "test", timeout: "5 ms", fetch: fetchOf(() => late.promise) });
    await assert.rejects(Questions.create({ model }).about("x").is("Ready?"), TimeoutError);
    late.reject(new Error("late rejection must be observed"));
    await tick();
  });
}

test("SDK bridge accepts readable timeouts and rejects conflicting numeric aliases", async () => {
  const model: AISDK.EvaluationModel = {
    provider: "test",
    modelId: "test",
    specificationVersion: "v4",
    supportedQuestionTypes: ["boolean"],
    doEvaluate: () => new Promise(() => {}),
  };
  assert.throws(() => AISDK.create({ model, timeout: "1s", timeoutMs: 1 }), ValidationError);
  await assert.rejects(
    Questions.create({ model: AISDK.create({ model, timeout: "5 ms" }) })
      .about("x")
      .is("x"),
    TimeoutError,
  );
});
