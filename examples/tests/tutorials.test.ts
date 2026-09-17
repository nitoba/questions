import { test, expect } from "bun:test";
import { Questions, TypeSafe } from "../../src/index.ts";
import { fixture, evidence } from "../../tests/helpers.ts";
import { main as first } from "../01-first-question.ts";
import { main as native } from "../02-native-question-schema.ts";
import { main as select, rooms } from "../03-select-and-route.ts";
import { main as collection } from "../04-collection-batching.ts";
import { main as liveContext } from "../05-live-context-investigation.ts";
import { main as costs } from "../06-evidence-and-decision-costs.ts";
import { main as schemas } from "../07-zod-decision-schemas.ts";
import { main as advanced } from "../07b-zod-advanced-inputs.ts";
import { main as diagnostics } from "../08-schema-diagnostics.ts";
import { main as policies } from "../09-derived-clients-and-observability.ts";
import { main as retry } from "../10-http-retries-and-deadlines.ts";
import { main as replay } from "../11-preparation-and-replay.ts";
import {
  main as providers,
  measured,
  selectedProvider,
} from "../12-providers-and-custom-models.ts";
import { main as pipelines } from "../13-bounded-stream-pipelines.ts";
import { main as stateful } from "../14-stateful-streams.ts";
import { main as nativeStreams } from "../15-native-stream-interop.ts";

/** These are deterministic TEST fixtures, never a tutorial's default runtime provider. */
test("01-06 execute the tutorial code through actual Questions operations", async () => {
  const f = fixture();
  const client = Questions.create({ model: f.model });
  expect((await first(client)).needsRamp).toBe(true);
  const before = f.calls.length;
  const maintenance = await native(client);
  expect(maintenance.category).toBe("electrical");
  expect(f.calls.length - before).toBe(2);
  const selected = await select(client);
  expect(selected.chosen).toBe(rooms[0]);
  expect(selected.ranking).toHaveLength(3);
  const rows = await collection(client);
  expect(rows.rows).toHaveLength(3);
  expect(rows.empty).toEqual([]);
  expect(JSON.stringify(f.calls)).not.toContain("supplierCost");
  expect(JSON.stringify(f.calls)).not.toContain("privateContact");
  expect((await liveContext(client)).settled).toBe(true);
  const result = await costs(client);
  expect(result.selected.choice).toBe("humanReview");
});

test("07-08 exercise Classic, Mini, transformations and diagnostics without extra inference", async () => {
  const f = fixture();
  const client = Questions.create({ model: f.model });
  expect((await schemas(client)).reviewQueue).toBe("damage-review");
  const results = await advanced(client);
  expect(Object.isFrozen(results.result)).toBe(true);
  expect(results.constant).toEqual({ format: "survey-v1" });
  expect(results.miniResult).toEqual([{ needsDocumentation: true }, { needsDocumentation: true }]);
  const before = f.calls.length;
  const result = await diagnostics(client);
  expect(f.calls.length - before).toBe(1);
  expect(result.fields.some((field) => JSON.stringify(field.path) === '["document.kind"]')).toBe(
    true,
  );
  expect(result.fields.some((field) => JSON.stringify(field.path) === '["document","kind"]')).toBe(
    true,
  );
});

test("09 composes defaults and semantic hooks without nested events", async () => {
  const result = await policies(fixture().model);
  expect(result.events).toEqual(["base:is", "release:is"]);
  expect(result.original.confidence).toBe(0.5);
  expect(result.derived.confidence).toBe(0.7);
});

test("10 uses real ofetch retry plumbing and sends the same request bytes", async () => {
  const bodies: string[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return new Response("", { status: 503 });
    const body = JSON.parse(String(init?.body));
    return Response.json({
      model: "http-test-only",
      usage: { input_tokens: 10, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.9 }]),
      ),
    });
  }) as typeof fetch;
  expect(await retry("test-key", fetcher)).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
});

test("11 captures old context and explicitly compares without rereading it", async () => {
  const f = fixture();
  const other = fixture();
  const result = await replay(Questions.create({ model: f.model }), other.model);
  expect(f.calls).toHaveLength(2);
  expect(other.calls).toHaveLength(1);
  expect(JSON.stringify(f.calls[0]?.state)).toContain("online portal");
  expect(f.calls[0]?.state).toEqual(f.calls[1]?.state);
  expect(result.first.operationId).not.toBe(result.second.operationId);
});

test("12 model decorators preserve this and cancellation; provider construction needs no network", async () => {
  const model = TypeSafe.create({ apiKey: "test-key" });
  const marker = Symbol("state");
  const signal = new AbortController().signal;
  const object = {
    name: model.name,
    marker,
    async evaluate(_request: unknown, options?: { signal?: AbortSignal }) {
      expect(this.marker).toBe(marker);
      expect(options?.signal).toBe(signal);
      return {};
    },
  };
  await measured(object, () => {}).evaluate({ state: "test", questions: {} }, { signal });
  const result = await providers(fixture().model);
  expect(result.timings).toHaveLength(1);
  const names = [
    "TYPESAFE_API_KEY",
    "AI_GATEWAY_API_KEY",
    "INFERENCE_BASE_URL",
    "INFERENCE_MODEL",
    "INFERENCE_API_KEY",
  ] as const;
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.INFERENCE_API_KEY = "test-key";
    process.env.INFERENCE_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.INFERENCE_MODEL = "fixture-only";
    for (const mode of ["typesafe", "jev", "vercel", "sdk", "system-one"]) {
      expect(typeof (await selectedProvider(mode)).evaluate).toBe("function");
    }
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
});

test("13-15 run bounded pipelines, state transitions and native reader ownership", async () => {
  const f = fixture();
  const rows = await pipelines(Questions.create({ model: f.model }));
  expect(rows.recommendations).toHaveLength(3);
  expect(f.calls.length).toBe(8);
  let calls = 0;
  const state = fixture((question) =>
    question.type === "boolean"
      ? { type: "boolean", probability: ++calls === 1 ? 0.95 : 0.05 }
      : evidence(question),
  );
  const result = await stateful(Questions.create({ model: state.model }));
  expect(result.events.map((event) => event.kind)).toEqual(["help-needed", "resolved"]);
  expect(result.beforeResolution).toHaveLength(1);
  const nativeResult = await nativeStreams();
  expect(nativeResult.saved.map((line) => JSON.parse(line).id)).toEqual(["CASE-1", "CASE-2"]);
  expect(nativeResult.contentType).toContain("application/x-ndjson");
});

test("08 inactive optional fields retain evidence without applying unused confidence gates", async () => {
  const f = fixture((question) =>
    question.type === "boolean" ? { type: "boolean", probability: 0.05 } : evidence(question),
  );
  const result = await diagnostics(Questions.create({ model: f.model }));
  const optionalValue = result.diagnostics.find(
    (field) => field.role === "value" && field.path.at(-1) === "attachment",
  );
  expect(optionalValue?.active).toBe(false);
  expect(optionalValue?.confidencePassed).toBeUndefined();
  expect(f.calls).toHaveLength(1);
});
