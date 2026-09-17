import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { z } from "zod";
import { createGateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModelV4Result as SDKResult } from "@ai-sdk/provider";
import {
  Questions,
  Question,
  Schema,
  Streams,
  ValidationError,
  ProviderError,
  TimeoutError,
  UncertainDecision,
} from "../src/index.ts";
import * as AISDK from "../src/providers/ai-sdk.ts";
import * as Vercel from "../src/providers/vercel.ts";
import { deferred, tick } from "./helpers.ts";

const batch = {
  ok: Question.boolean("OK?"),
  route: Question.choice("Route?", { a: { label: "A" }, b: "B" }),
  score: Question.score("Impact?", ["Low", "Mid", "High"]),
};
function result(): SDKResult {
  return {
    answers: {
      ok: { type: "boolean", probability: 0.9 },
      route: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } },
      score: { type: "score", score: 1.3, probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 } },
    },
    usage: { inputTokens: 4, outputTokens: 2 },
    warnings: [{ type: "other", message: "For caller review" }],
    providerMetadata: { gateway: { routing: "primary" } },
    response: { modelId: "resolved-model", body: { secret: "do-not-copy" } },
  };
}
function sdk(
  doEvaluate: AISDK.EvaluationModel["doEvaluate"] = async () => result(),
): AISDK.EvaluationModel {
  return {
    specificationVersion: "v4",
    provider: "test-sdk",
    modelId: "test-model",
    supportedQuestionTypes: ["boolean", "choice", "score"],
    doEvaluate,
  };
}
const transport = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  fn as typeof fetch;
const q = (model: AISDK.EvaluationModel, options: Omit<AISDK.Options, "model"> = {}) =>
  Questions.create({ model: AISDK.create({ model, ...options }) }).about("context");

function booleanResults(questions: Record<string, { type: string }>) {
  return {
    answers: Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "boolean" as const, probability: 0.9 }]),
    ),
  };
}

test("SDK adapter forwards one normalized batch and keeps this binding, metadata and actual model", async () => {
  let calls = 0;
  const model = sdk(async function (this: AISDK.EvaluationModel, request) {
    assert.equal(this, model);
    calls++;
    assert.equal(request.state, "context");
    assert.deepEqual(request.questions.route, batch.route);
    assert.equal(request.questions.ok?.type, "boolean"); // never System One noul
    assert.ok(request.abortSignal);
    return result();
  });
  const evidence = await q(model).evidence(batch);
  assert.equal(calls, 1);
  assert.equal(evidence.model, "resolved-model");
  assert.deepEqual(evidence.usage, { inputTokens: 4, outputTokens: 2 });
  assert.ok(Math.abs(evidence.answers.route.confidence - 0.6) < 1e-10);
  assert.equal(evidence.answers.route.confidenceSource, "margin");
  assert.equal(evidence.answers.score.confidenceSource, "margin");
  assert.deepEqual(evidence.answers.score.legend, { "0": "Low", "1": "Mid", "2": "High" });
  assert.deepEqual(evidence.warnings, result().warnings);
  assert.deepEqual(evidence.providerMetadata, result().providerMetadata);
  assert.equal("response" in evidence, false);
  assert.equal(JSON.stringify(evidence).includes("do-not-copy"), false);
  assert.ok(Object.isFrozen(evidence.providerMetadata?.gateway));
});

test("SDK optional usage is unknown instead of fabricated zero; missing model uses configured ID", async () => {
  const model = sdk(async () => ({
    answers: { answer: { type: "boolean", probability: 0.9 } },
    warnings: [],
  }));
  const evidence = await q(model).evidence({ answer: "OK?" });
  assert.deepEqual(evidence.usage, {});
  assert.equal(evidence.usage.inputTokens, undefined);
  assert.equal(evidence.model, "test-model");
});

test("unsupported version, text models, malformed config and capabilities fail before doEvaluate", async () => {
  let calls = 0;
  const model = sdk(async () => {
    calls++;
    return result();
  });
  for (const broken of [
    null,
    {},
    { ...model, specificationVersion: "v3" },
    { ...model, supportedQuestionTypes: ["text"] },
  ])
    assert.throws(() => AISDK.create({ model: broken as AISDK.EvaluationModel }), ValidationError);
  assert.throws(
    () => AISDK.create({ model, providerOptions: { gateway: { value: NaN } } }),
    ValidationError,
  );
  assert.throws(() => AISDK.create({ model, confidence: "entropy" as "margin" }), ValidationError);
  assert.throws(() => AISDK.create({ model, timeoutMs: 0 }), ValidationError);
  await assert.rejects(
    q({ ...model, supportedQuestionTypes: ["boolean"] }).ask(batch),
    ValidationError,
  );
  assert.equal(calls, 0);
});

test("missing distributions never become fake certainty for choices or scores", async () => {
  for (const key of ["route", "score"] as const) {
    const output = result();
    const answer = output.answers[key];
    assert.ok(answer && answer.type !== "boolean");
    delete answer.probabilities;
    await assert.rejects(
      q(sdk(async () => output)).ask(batch),
      (error) => error instanceof ValidationError && error.path.endsWith(".probabilities"),
    );
  }
});

test("the complete SDK response is validated before any user confidence or Zod callback", async () => {
  let calls = 0;
  const invalid = result();
  invalid.answers.score = { type: "score", score: 1, probabilities: { "0": 0, "1": 0, "2": 0 } };
  await assert.rejects(
    q(
      sdk(async () => invalid),
      {
        confidence: () => {
          calls++;
          return 1;
        },
      },
    ).ask(batch),
    ValidationError,
  );
  const schema = z.enum(["a", "b"]).transform(() => {
    calls++;
    return "transformed";
  });
  await assert.rejects(
    q(sdk(async () => ({ answers: { q0: { type: "choice", choice: "a" } }, warnings: [] }))).ask(
      schema,
    ),
    ValidationError,
  );
  assert.equal(calls, 0);
});

test("custom confidence has frozen typed evidence, validates output and records provenance", async () => {
  const bound = q(sdk(), {
    confidence: (evidence, context) => {
      assert.equal("confidence" in evidence, false);
      assert.ok(Object.isFrozen(evidence.probabilities));
      assert.equal(context.modelId, "resolved-model");
      return 0.75;
    },
  });
  const evidence = await bound.evidence(batch);
  assert.equal(evidence.answers.route.confidence, 0.75);
  assert.equal(evidence.answers.route.confidenceSource, "custom");
  assert.equal(evidence.answers.score.confidence, 0.75);
  for (const invalid of [-1, 1.01, NaN, Infinity])
    await assert.rejects(q(sdk(), { confidence: () => invalid }).ask(batch), ValidationError);
  const failure = new Error("policy failure");
  await assert.rejects(
    q(sdk(), {
      confidence: () => {
        throw failure;
      },
    }).ask(batch),
    (error) => error === failure,
  );
});

test("margin confidence gates branches without running handlers", async () => {
  let ran = false;
  const model = sdk(async ({ questions }) => ({
    warnings: [],
    answers: Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        { type: "choice" as const, choice: "a", probabilities: { a: 0.6, b: 0.4 } },
      ]),
    ),
  }));
  await assert.rejects(
    q(model).branch(
      "Which?",
      {
        a: () => {
          ran = true;
        },
        b: () => {
          ran = true;
        },
      },
      { confidence: 0.5 },
    ),
    UncertainDecision,
  );
  assert.equal(ran, false);
});

test("reported rounding is preserved through client and compiled Zod parsing", async () => {
  const schema = z.enum(["a", "b", "c"]);
  const compiled = Schema.compile(schema);
  const question = compiled.questions.q0;
  assert.ok(question?.type === "choice");
  const keys = Object.keys(question.criteria);
  const probabilities = Object.fromEntries(keys.map((key) => [key, 0.333]));
  const rounded: SDKResult = {
    warnings: [],
    rounding: { probabilityDecimals: 3 },
    answers: { q0: { type: "choice", choice: keys[0]!, probabilities } },
  };
  assert.equal(await q(sdk(async () => rounded)).ask(schema), "a");
  const evidence = await q(sdk(async () => rounded)).evidence(compiled.questions);
  assert.deepEqual(evidence.rounding, { probabilityDecimals: 3 });
  assert.deepEqual(
    (evidence.answers.q0 as { probabilities: unknown }).probabilities,
    probabilities,
  );
  assert.equal(await compiled.parse(evidence), "a");
  delete rounded.rounding;
  await assert.rejects(q(sdk(async () => rounded)).ask(schema), ValidationError);
});

test("rounded scores honor declared precision but reject inconsistent mass, scores and winners", async () => {
  const schema = z.number().register(Schema.registry, { kind: "score", levels: ["A", "B", "C"] });
  const rounded: SDKResult = {
    warnings: [],
    rounding: { probabilityDecimals: 3, scoreDecimals: 2 },
    answers: {
      q0: { type: "score", score: 1, probabilities: { "0": 0.333, "1": 0.333, "2": 0.333 } },
    },
  };
  assert.equal(await q(sdk(async () => rounded)).ask(schema), 1);
  rounded.answers.q0 = {
    type: "score",
    score: 1.1,
    probabilities: { "0": 0.333, "1": 0.333, "2": 0.333 },
  };
  await assert.rejects(q(sdk(async () => rounded)).ask(schema), ValidationError);
  for (const decimals of [-1, 1.2, Infinity, 16]) {
    rounded.rounding = { probabilityDecimals: decimals };
    await assert.rejects(q(sdk(async () => rounded)).ask(schema), ValidationError);
  }
  const bad = result();
  bad.rounding = { probabilityDecimals: 1 };
  bad.answers.route = { type: "choice", choice: "b", probabilities: { a: 0.8, b: 0.2 } };
  await assert.rejects(q(sdk(async () => bad)).ask(batch), ValidationError);
});

test("SDK metadata, keys, token counts and probability invariants are untrusted", async () => {
  for (const mutate of [
    (value: SDKResult) => {
      value.usage = { inputTokens: -1 };
    },
    (value: SDKResult) => {
      value.answers.extra = { type: "boolean", probability: 0.9 };
    },
    (value: SDKResult) => {
      delete value.answers.ok;
    },
    (value: SDKResult) => {
      value.answers.ok = { type: "boolean", probability: NaN };
    },
    (value: SDKResult) => {
      value.providerMetadata = { p: { x: Infinity } };
    },
    (value: SDKResult) => {
      value.warnings = [{ type: "other", message: 123 as unknown as string }];
    },
  ]) {
    const output = result();
    mutate(output);
    await assert.rejects(q(sdk(async () => output)).ask(batch), ValidationError);
  }
});

test("SDK settings are snapshotted and model mutation cannot poison following calls", async () => {
  const headers = { "x-project": "first" };
  const providerOptions = { gateway: { order: ["typesafe-ai"] } };
  const model = sdk(async (request) => {
    assert.equal(request.headers?.["x-project"], "first");
    assert.deepEqual(request.providerOptions, { gateway: { order: ["typesafe-ai"] } });
    request.providerOptions!.gateway.order.push("poison");
    return { warnings: [], ...booleanResults(request.questions) };
  });
  const bound = q(model, { headers, providerOptions });
  headers["x-project"] = "changed";
  providerOptions.gateway.order.push("other");
  model.doEvaluate = async () => {
    throw new Error("must use captured method");
  };
  assert.equal(await bound.is("OK?"), true);
  assert.equal(await bound.is("OK?"), true);
});

test("SDK never retries an error and preserves its identity", async () => {
  let calls = 0;
  const failure = Object.assign(new Error("upstream"), { statusCode: 429, isRetryable: true });
  await assert.rejects(
    q(
      sdk(async () => {
        calls++;
        throw failure;
      }),
    ).is("OK?"),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("SDK pre-abort, cooperative abort and late rejection obey signal lifecycle", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    q(
      sdk(async () => {
        calls++;
        return result();
      }),
    ).is("OK?", { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  const acquired = deferred<AbortSignal>();
  const pending = deferred<SDKResult>();
  const operation = q(
    sdk(({ abortSignal }) => {
      acquired.resolve(abortSignal!);
      return pending.promise;
    }),
    { timeoutMs: 10 },
  ).is("OK?");
  const signal = await acquired.promise;
  await assert.rejects(operation, TimeoutError);
  assert.equal(signal.aborted, true);
  pending.reject(new Error("late"));
  await tick();
});

test("Zod inference, each batching and native streams remain provider-neutral", async () => {
  let calls = 0;
  const client = Questions.create({
    model: AISDK.create({
      model: sdk(async (request) => {
        calls++;
        return { warnings: [], ...booleanResults(request.questions) };
      }),
    }),
  });
  const schema = z
    .object({ ok: z.boolean().describe("OK?") })
    .transform((value) => ({ accepted: value.ok }));
  assert.deepEqual(await client.each(["one", "two"]).ask(schema), [
    { accepted: true },
    { accepted: true },
  ]);
  assert.equal(calls, 1);
  const stream = Streams.from(["one", "two"]).map(
    (item, { signal }) => client.about(item).ask(schema, { signal }),
    { concurrency: 2 },
  );
  assert.deepEqual(await stream.toArray(), [{ accepted: true }, { accepted: true }]);
  assert.equal(calls, 3);
});

test("Vercel uses the installed official SDK endpoint, model headers and normalized wire schema", async () => {
  let calls = 0;
  const model = Vercel.create({
    apiKey: "gateway-key",
    teamIdOrSlug: "my-team",
    headers: { "x-app": "questions" },
    providerOptions: { gateway: { order: ["typesafe-ai"] } },
    fetch: transport(async (input, init) => {
      calls++;
      assert.equal(String(input), "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer gateway-key");
      assert.equal(headers.get("ai-model-id"), "typesafe-ai/jev");
      assert.equal(headers.get("ai-evaluation-model-specification-version"), "4");
      assert.equal(headers.get("x-vercel-ai-gateway-team"), "my-team");
      assert.equal(headers.get("x-app"), "questions");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal("model" in body, false);
      assert.equal(body.questions.ok.type, "boolean");
      assert.deepEqual(body.providerOptions, { gateway: { order: ["typesafe-ai"] } });
      return Response.json(result());
    }),
  });
  const evidence = await Questions.create({ model }).about("x").evidence(batch);
  assert.equal(evidence.model, "typesafe-ai/jev");
  assert.equal(evidence.answers.route.confidenceSource, "margin");
  assert.equal(calls, 1);
});

test("existing official Gateway evaluation models can be reused through AISDK", async () => {
  const gateway = createGateway({
    apiKey: "key",
    fetch: transport(async (_, init) =>
      Response.json(booleanResults(JSON.parse(String(init?.body)).questions)),
    ),
  });
  assert.equal(await q(gateway.evaluationModel("typesafe-ai/jev")).is("OK?"), true);
});

test("Vercel custom prefix and model are explicit without appending OpenAI paths", async () => {
  const client = Questions.create({
    model: Vercel.create({
      apiKey: "key",
      baseURL: "https://proxy.test/service/v4/ai/",
      model: "custom/eval",
      fetch: transport(async (input, init) => {
        assert.equal(String(input), "https://proxy.test/service/v4/ai/evaluation-model");
        assert.equal(new Headers(init?.headers).get("ai-model-id"), "custom/eval");
        return Response.json(booleanResults(JSON.parse(String(init?.body)).questions));
      }),
    }),
  });
  assert.equal(await client.about("x").is("OK?"), true);
});

test("Vercel rejects invalid config and managed header overrides eagerly", () => {
  for (const extra of [
    { apiKey: "" },
    { baseURL: "https://user:secret@host.test" },
    { maxResponseBytes: 0 },
    { timeoutMs: 0 },
    { model: "" },
    { model: "bad\r\nheader" },
    { teamIdOrSlug: "bad\r\nheader" },
  ])
    assert.throws(() => Vercel.create({ apiKey: "key", ...extra }), ValidationError);
  for (const name of [
    "authorization",
    "ai-model-id",
    "ai-evaluation-model-specification-version",
    "x-vercel-ai-gateway-team",
  ])
    assert.throws(
      () => Vercel.create({ apiKey: "key", headers: { [name]: "override" } }),
      ValidationError,
    );
});

test("Vercel HTTP/network errors are sanitized and not retried", async () => {
  for (const status of [401, 429, 500, 529]) {
    let calls = 0;
    const client = Questions.create({
      model: Vercel.create({
        apiKey: "hidden-key",
        fetch: transport(async () => {
          calls++;
          return new Response("hidden-body", { status });
        }),
      }),
    });
    await assert.rejects(
      client.about("private-state").is("OK?"),
      (error) =>
        error instanceof ProviderError &&
        error.status === status &&
        !JSON.stringify(error).includes("hidden") &&
        !JSON.stringify(error).includes("private-state"),
    );
    assert.equal(calls, 1);
  }
  const client = Questions.create({
    model: Vercel.create({
      apiKey: "key",
      fetch: transport(async () => {
        throw new Error("secret-url");
      }),
    }),
  });
  await assert.rejects(
    client.about("x").is("OK?"),
    (error) =>
      error instanceof ProviderError &&
      error.kind === "network" &&
      !String(error).includes("secret-url"),
  );
});

test("Vercel rejects oversized, invalid JSON/UTF-8 and incomplete SDK evidence", async () => {
  const bodies = [
    () => new Response("x".repeat(200)),
    () => new Response("{invalid-json"),
    () => new Response(new Uint8Array([0xff])),
    () => Response.json({ answers: {} }),
  ];
  for (const body of bodies) {
    const client = Questions.create({
      model: Vercel.create({
        apiKey: "key",
        maxResponseBytes: 150,
        fetch: transport(async () => body()),
      }),
    });
    await assert.rejects(
      client.about("x").is("OK?"),
      (error) => error instanceof ProviderError || error instanceof ValidationError,
    );
  }
});

test("Vercel timeout includes SDK response reads and releases the native reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const client = Questions.create({
    model: Vercel.create({
      apiKey: "key",
      timeoutMs: 10,
      fetch: transport(async () => new Response(body)),
    }),
  });
  await assert.rejects(client.about("x").is("OK?"), TimeoutError);
  await tick();
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("Vercel sends a real localhost HTTP evaluation using the official SDK", async () => {
  const server = createServer(async (request, response) => {
    let content = "";
    for await (const chunk of request) content += String(chunk);
    assert.equal(request.url, "/gateway/evaluation-model");
    assert.equal(request.headers.authorization, "Bearer local-test");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(booleanResults(JSON.parse(content).questions)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const client = Questions.create({
      model: Vercel.create({
        apiKey: "local-test",
        baseURL: `http://127.0.0.1:${address.port}/gateway`,
      }),
    });
    assert.equal(await client.about("x").ask(z.boolean().describe("OK?")), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
