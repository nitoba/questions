import { test } from "bun:test";
import assert from "node:assert/strict";
import {
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
  const model = TypeSafe.create({
    apiKey: "key",
    fetch: transport(() => {
      calls++;
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
