import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  Question,
  Questions,
  SystemOne,
  TypeSafe,
  Jev,
  ValidationError,
  ProviderError,
  TimeoutError,
} from "../src/index.ts";
import { deferred, tick } from "./helpers.ts";

const wire = {
  model: "hosted",
  usage: { input_tokens: 3, output_tokens: 1 },
  answers: { answer: { type: "noul", noul: 0.9 } },
};
const transport = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  handler as typeof globalThis.fetch;

test("SystemOne uses explicit host, model and path, without TypeSafe defaults", async () => {
  const headers = new Headers({ "x-project": "a" });
  let calls = 0;
  const model = SystemOne.create({
    baseURL: "https://private.example/proxy/v2///",
    path: "decisions/evaluate",
    apiKey: "host-key",
    model: "other-jev",
    headers,
    fetch: transport(async (url, init) => {
      calls++;
      assert.equal(String(url), "https://private.example/proxy/v2/decisions/evaluate");
      const actual = new Headers(init?.headers);
      assert.equal(actual.get("x-project"), "a");
      assert.equal(actual.get("authorization"), "Bearer host-key");
      assert.equal(JSON.parse(String(init?.body)).model, "other-jev");
      // A custom fetch cannot poison subsequent requests by mutating its headers or URL.
      assert.ok(init);
      (init.headers as Headers).set("x-project", "mutated");
      (url as URL).pathname = "/wrong";
      return Response.json(wire);
    }),
  });
  headers.set("x-project", "changed");
  const q = Questions.create({ model }).about("x");
  assert.equal(await q.is("OK?"), true);
  assert.equal(await q.is("OK?"), true);
  assert.equal(calls, 2);
  assert.equal(model.name, "SystemOne");
});

test("TypeSafe is a preset; Jev keeps its original diagnostic name and baseUrl alias", async () => {
  for (const factory of [TypeSafe.create, Jev.create]) {
    const model = factory({
      apiKey: "key",
      fetch: transport(async (url, init) => {
        assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
        assert.equal(JSON.parse(String(init?.body)).model, "jev-latest");
        return Response.json(wire);
      }),
    });
    assert.equal(await Questions.create({ model }).about("x").is("OK?"), true);
  }
  assert.equal(Jev.create({ apiKey: "key" }).name, "Jev");
  assert.equal(TypeSafe.create({ apiKey: "key" }).name, "TypeSafe");
  assert.throws(
    () => Jev.create({ apiKey: "key", baseUrl: "https://a.test", baseURL: "https://a.test" }),
    ValidationError,
  );
});

// Jev payloads from issue #2: scores and probabilities rounded independently to two decimals.
const roundedScores = {
  c0q0: { score: 3.48, probabilities: { 0: 0.01, 1: 0.01, 2: 0.01, 3: 0.44, 4: 0.53 } },
  c2q0: { score: 3.71, probabilities: { 0: 0, 1: 0.01, 2: 0.01, 3: 0.22, 4: 0.76 } },
  c7q0: { score: 2.76, probabilities: { 0: 0, 1: 0.04, 2: 0.18, 3: 0.74, 4: 0.04 } },
  c25q0: { score: 3.09, probabilities: { 0: 0, 1: 0, 2: 0.12, 3: 0.65, 4: 0.23 } },
};
const levels = ["none", "low", "some", "high", "full"] as const;
const scoreBatch = {
  c0q0: Question.score("Fit?", levels),
  c2q0: Question.score("Fit?", levels),
  c7q0: Question.score("Fit?", levels),
  c25q0: Question.score("Fit?", levels),
};
const roundedWire = (rounding?: unknown) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 3, output_tokens: 1 },
  ...(rounding === undefined ? {} : { rounding }),
  answers: Object.fromEntries(
    Object.entries(roundedScores).map(([key, answer]) => [
      key,
      {
        type: "score",
        ...answer,
        confidence: 0.5,
        legend: Object.fromEntries(levels.map((level, index) => [index, level])),
      },
    ]),
  ),
});

test("TypeSafe and Jev declare the two-decimal rounding Jev applies silently", async () => {
  for (const factory of [TypeSafe.create, Jev.create]) {
    const model = factory({
      apiKey: "key",
      fetch: transport(async () => Response.json(roundedWire())),
    });
    const evidence = await Questions.create({ model }).about("x").evidence(scoreBatch);
    assert.deepEqual(evidence.rounding, { probabilityDecimals: 2, scoreDecimals: 2 });
    // Values are preserved as reported, not normalized to the weighted level index.
    assert.equal(evidence.answers.c0q0.score, 3.48);
    assert.equal(evidence.answers.c2q0.probabilities[4], 0.76);
  }
});

test("reported rounding wins over the declaration; SystemOne stays strict by default", async () => {
  const reported = TypeSafe.create({
    apiKey: "key",
    fetch: transport(async () => Response.json(roundedWire({ probabilityDecimals: 3 }))),
  });
  await assert.rejects(
    Questions.create({ model: reported }).about("x").evidence(scoreBatch),
    (error) => error instanceof ValidationError && error.path === "response.answers.c0q0.score",
  );
  const strict = SystemOne.create({
    baseURL: "https://a.test",
    model: "m",
    fetch: transport(async () => Response.json(roundedWire())),
  });
  await assert.rejects(
    Questions.create({ model: strict }).about("x").evidence(scoreBatch),
    ValidationError,
  );
  const declared = SystemOne.create({
    baseURL: "https://a.test",
    model: "m",
    rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
    fetch: transport(async () => Response.json(roundedWire())),
  });
  const evidence = await Questions.create({ model: declared }).about("x").evidence(scoreBatch);
  assert.deepEqual(evidence.rounding, { probabilityDecimals: 2, scoreDecimals: 2 });
  const narrower = TypeSafe.create({
    apiKey: "key",
    rounding: { probabilityDecimals: 4, scoreDecimals: 4 },
    fetch: transport(async () => Response.json(roundedWire())),
  });
  await assert.rejects(
    Questions.create({ model: narrower }).about("x").evidence(scoreBatch),
    ValidationError,
  );
});

test("generic local endpoint may explicitly omit authentication; presets require it", async () => {
  const model = SystemOne.create({
    baseURL: "http://localhost:9999",
    model: "local",
    fetch: transport(async (_, init) => {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json(wire);
    }),
  });
  assert.equal(await Questions.create({ model }).about("x").is("OK?"), true);
  for (const create of [Jev.create, TypeSafe.create]) {
    assert.throws(() => create({ apiKey: undefined as unknown as string }), ValidationError);
    assert.throws(() => create({ apiKey: "key\r\nx-injected: true" }), ValidationError);
  }
});

test("invalid URLs, paths, headers and configs fail before fetch without disclosing secrets", () => {
  const create = (extra: Partial<SystemOne.Options>) =>
    SystemOne.create({ baseURL: "https://a.test/v1", model: "m", ...extra });
  for (const baseURL of [
    "not a URL",
    "file:///tmp",
    "https://user:password@a.test",
    "https://a.test/?api_key=secret",
    "https://a.test/#fragment",
  ])
    assert.throws(
      () => create({ baseURL }),
      (error) =>
        error instanceof ValidationError &&
        !String(error).includes("password") &&
        !String(error).includes("secret"),
    );
  for (const path of ["/v1", "../admin", "https://b.test", "\\systemone", "a?key=x", "a%2fb", ""])
    assert.throws(() => create({ path }), ValidationError);
  for (const key of ["Authorization", "CONTENT-TYPE", "Host", "Content-Length"])
    assert.throws(() => create({ headers: { [key]: "unsafe" } }), ValidationError);
  assert.throws(() => create({ model: "" }), ValidationError);
  assert.throws(() => create({ maxCriteria: 1 }), ValidationError);
  for (const rounding of [{ probabilityDecimals: 16 }, { probabilityDecimals: -1 }, { digits: 2 }])
    assert.throws(
      () => create({ rounding: rounding as NonNullable<SystemOne.Options["rounding"]> }),
      (error) => error instanceof ValidationError && error.path.startsWith("rounding"),
    );
  assert.throws(
    () => create({ retry: { maxRetries: 1, jitter: "yes" as unknown as boolean } }),
    ValidationError,
  );
});

test("provider errors identify the configured host label and never include HTTP bodies", async () => {
  const model = SystemOne.create({
    name: "Internal inference",
    baseURL: "https://private.test",
    model: "m",
    apiKey: "secret",
    fetch: transport(async () => new Response("private-input", { status: 503 })),
  });
  await assert.rejects(
    Questions.create({ model }).about("x").is("OK?"),
    (error) =>
      error instanceof ProviderError &&
      error.provider === "Internal inference" &&
      error.status === 503 &&
      !JSON.stringify(error).includes("private-input"),
  );
  assert.ok(!JSON.stringify(model).includes("secret"));
});

test("HTTP cleanup never waits for an uncooperative source cancel promise", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
      return new Promise(() => {});
    },
  });
  const model = TypeSafe.create({
    apiKey: "key",
    timeoutMs: 10,
    fetch: transport(async () => new Response(body)),
  });
  await assert.rejects(
    model.evaluate({ state: "x", questions: { answer: { type: "boolean", instructions: "OK?" } } }),
    TimeoutError,
  );
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

test("HTTP error cleanup cannot block returning a status error", async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      return new Promise(() => {});
    },
  });
  const model = TypeSafe.create({
    apiKey: "key",
    fetch: transport(async () => new Response(body, { status: 401 })),
  });
  await assert.rejects(
    model.evaluate({ state: "x", questions: { answer: { type: "boolean", instructions: "OK?" } } }),
    (error) => error instanceof ProviderError && error.status === 401,
  );
});

test("pre-abort skips HTTP and late responses are closed", async () => {
  let calls = 0;
  let canceled = false;
  const pending = deferred<Response>();
  const started = deferred<void>();
  const model = TypeSafe.create({
    apiKey: "key",
    fetch: transport(() => {
      calls++;
      started.resolve();
      return pending.promise;
    }),
  });
  const request = {
    state: "x",
    questions: { answer: { type: "boolean" as const, instructions: "OK?" } },
  };
  const stop = new Error("stop");
  await assert.rejects(
    model.evaluate(request, { signal: AbortSignal.abort(stop) }),
    (e) => e === stop,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  const result = model.evaluate(request, { signal: controller.signal });
  await started.promise; // ofetch async onRequest hooks precede native dispatch.
  controller.abort(stop);
  await assert.rejects(result, (e) => e === stop);
  pending.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    ),
  );
  await tick();
  assert.equal(canceled, true);
});
