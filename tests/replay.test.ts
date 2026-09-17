import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Questions,
  Question,
  Schema,
  Streams,
  ValidationError,
  UncertainDecision,
} from "../src/index.ts";
import { fixture, deferred, tick } from "./helpers.ts";
import type { QuestionModel } from "../src/model.ts";

test("run exposes typed value, complete evidence and an explicit fresh replay", async () => {
  let calls = 0,
    sources = 0;
  const { model } = fixture(() => ({ type: "boolean", probability: ++calls === 1 ? 0.9 : 0.1 }));
  const q = Questions.create({ model }).about(() => {
    sources++;
    return { source: sources };
  });
  const first = await q.run(z.object({ ok: z.boolean() }));
  assert.deepEqual(first.value, { ok: true });
  assert.equal(first.evidence?.usage.inputTokens, 12);
  const second = await first.replay();
  assert.deepEqual(second.value, { ok: false });
  assert.equal(sources, 1);
  assert.equal(calls, 2);
  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
});

test("prepare snapshots nested context, definitions and metadata without inference or parsing", async () => {
  const { model, calls } = fixture();
  const input = { nested: { labels: ["before"] } };
  let parses = 0;
  const leaf = z.boolean().describe("Original instructions");
  const schema = z.object({ ok: leaf }).transform((v) => {
    parses++;
    return { ...v, parses };
  });
  const prepared = await Questions.create({ model }).about(input).prepare(schema);
  assert.equal(calls.length, 0);
  assert.equal(parses, 0);
  input.nested.labels.push("after");
  Schema.annotate(leaf, { instructions: "Changed" });
  assert.deepEqual(prepared.request?.state, { nested: { labels: ["before"] } });
  assert.throws(() => {
    (prepared.request!.state as typeof input).nested.labels.push("mutation");
  });
  assert.ok(Object.isFrozen(prepared.request));
  const first = await prepared.run();
  const second = await first.replay();
  assert.equal(parses, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.ok(!JSON.stringify(calls).includes("Changed"));
  assert.deepEqual(first.value, { ok: true, parses: 1 });
  assert.deepEqual(second.value, { ok: true, parses: 2 });
});

test("plain batches retain keys and prepared inputs cannot change across an awaited source", async () => {
  const { model, calls } = fixture();
  const source = deferred<string>();
  const batch = { ready: "Original?", route: Question.choice("Which?", { a: "A", b: "B" }) };
  const pending = Questions.create({ model })
    .about(() => source.promise)
    .prepare(batch);
  batch.ready = "Changed?";
  source.resolve("context");
  const prepared = await pending;
  const result = await prepared.run();
  assert.equal(result.value.route, "a");
  assert.equal(result.evidence?.answers.route.choice, "a");
  assert.equal(calls[0]?.questions.ready?.instructions, "Original?");
});

test("prepared runs recover after a failed inference without automatic retries", async () => {
  const fail = new Error("transport");
  const { model: delegate, calls } = fixture();
  let attempts = 0;
  const model: QuestionModel = {
    name: "intermittent",
    async evaluate(request, options) {
      if (++attempts === 1) throw fail;
      return delegate.evaluate(request, options);
    },
  };
  let sources = 0;
  const prepared = await Questions.create({ model })
    .about(() => {
      sources++;
      return "state";
    })
    .prepare({ ok: "OK?" });
  await assert.rejects(prepared.run(), (e) => e === fail);
  assert.equal(attempts, 1);
  assert.equal((await prepared.run()).value.ok, true);
  assert.equal(sources, 1);
  assert.equal(calls.length, 1);
});

test("replay may explicitly change providers and retains that choice in subsequent replays", async () => {
  const firstProvider = fixture(),
    secondProvider = fixture(() => ({ type: "boolean", probability: 0.1 }));
  const first = await Questions.create({ model: firstProvider.model })
    .about("x")
    .run({ ok: "OK?" });
  const second = await first.replay({ model: secondProvider.model });
  const third = await second.replay();
  assert.equal(first.value.ok, true);
  assert.equal(second.value.ok, false);
  assert.equal(third.value.ok, false);
  assert.equal(firstProvider.calls.length, 1);
  assert.equal(secondProvider.calls.length, 2);
  assert.deepEqual(firstProvider.calls[0], secondProvider.calls[0]);
});

test("execution and preparation do not retain prior abort signals", async () => {
  const { model, calls } = fixture();
  const parent = new AbortController();
  const prepared = await Questions.create({ model })
    .about("x")
    .prepare(z.boolean(), { signal: parent.signal });
  parent.abort(new Error("preparation is over"));
  const controller = new AbortController();
  const first = await prepared.run({ signal: controller.signal });
  controller.abort(new Error("old run stopped"));
  assert.equal((await first.replay()).value, true);
  const stop = new Error("skip replay");
  await assert.rejects(first.replay({ signal: AbortSignal.abort(stop) }), (e) => e === stop);
  assert.equal(calls.length, 2);
});

test("invalid schema and confidence fail before live context or provider activity", async () => {
  const { model, calls } = fixture();
  let sources = 0;
  const q = Questions.create({ model }).about(() => {
    sources++;
    return "x";
  });
  await assert.rejects(q.prepare(z.string()), ValidationError);
  await assert.rejects(q.run(z.boolean(), { confidence: NaN }), ValidationError);
  await assert.rejects(q.prepare({}), ValidationError);
  const stop = new Error("stop");
  await assert.rejects(
    q.prepare(z.boolean(), { signal: AbortSignal.abort(stop) }),
    (e) => e === stop,
  );
  assert.equal(sources, 0);
  assert.equal(calls.length, 0);
});

test("constant-only schemas never resolve context or infer but transform once per explicit run", async () => {
  const { model, calls } = fixture();
  const q = Questions.create({ model }).about(() => {
    throw new Error("must not read context");
  });
  let parsed = 0;
  const prepared = await q.prepare(
    z.literal("fixed").transform((value) => {
      parsed++;
      return value;
    }),
  );
  assert.equal(prepared.request, undefined);
  assert.equal(parsed, 0);
  const result = await prepared.run();
  await result.replay();
  assert.equal(result.evidence, undefined);
  assert.equal(parsed, 2);
  assert.equal(calls.length, 0);
});

test("confidence survives replay and user callbacks cannot bypass malformed/uncertain evidence", async () => {
  let parses = 0;
  const { model } = fixture();
  const first = await Questions.create({ model })
    .about("x")
    .run(
      z.boolean().transform((v) => {
        parses++;
        return v;
      }),
      { confidence: 0.7 },
    );
  const weak = fixture(() => ({ type: "boolean", probability: 0.6 }));
  await assert.rejects(first.replay({ model: weak.model }), UncertainDecision);
  assert.equal(parses, 1);
  assert.equal((await first.replay({ model: weak.model, confidence: 0 })).value, true);
  assert.equal(parses, 2);
  const bad = fixture(() => ({ type: "boolean", probability: 3 }));
  await assert.rejects(first.replay({ model: bad.model }), ValidationError);
  assert.equal(parses, 2);
});

test("output transforms rerun exactly once, are not cached, and retain thrown values", async () => {
  const { model, calls } = fixture();
  const cause = { failure: "transform" };
  let parses = 0;
  const prepared = await Questions.create({ model })
    .about("x")
    .prepare(
      z.boolean().transform(async (v) => {
        if (++parses === 1) throw cause;
        return { v };
      }),
    );
  await assert.rejects(prepared.run(), (e) => e === cause);
  const next = await prepared.run();
  assert.deepEqual(next.value, { v: true });
  assert.equal(parses, 2);
  assert.equal(calls.length, 2);
  next.value.v = false; // mutable output unless the schema says readonly; snapshots are independent.
  assert.deepEqual((await next.replay()).value, { v: true });
});

test("aborting live capture observes late failure and performs no inference", async () => {
  const { model, calls } = fixture();
  const pending = deferred<string>(),
    started = deferred<void>(),
    controller = new AbortController();
  const reason = new Error("stop context");
  const work = Questions.create({ model })
    .about(() => {
      started.resolve();
      return pending.promise;
    })
    .prepare(z.boolean(), { signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(work, (e) => e === reason);
  pending.reject(new Error("late"));
  await tick();
  assert.equal(calls.length, 0);
});

test("replay abort is local to that run and independent concurrent runs still finish", async () => {
  const { model: delegate, calls } = fixture();
  let count = 0;
  const pending = deferred<unknown>(),
    started = deferred<void>();
  const model: QuestionModel = {
    name: "local-abort",
    async evaluate(request, options) {
      if (++count === 2) {
        started.resolve();
        return pending.promise;
      }
      return delegate.evaluate(request, options);
    },
  };
  const first = await Questions.create({ model }).about("x").run(z.boolean());
  const controller = new AbortController(),
    reason = new Error("stop this replay");
  const second = first.replay({ signal: controller.signal });
  await started.promise;
  const third = first.replay();
  controller.abort(reason);
  await assert.rejects(second, (e) => e === reason);
  assert.equal((await third).value, true);
  pending.reject(new Error("late"));
  await tick();
  assert.equal(calls.length, 2);
});

test("replay works in Web Streams without replaying downstream application actions", async () => {
  const { model, calls } = fixture();
  const execution = await Questions.create({ model })
    .about("x")
    .run(z.object({ ok: z.boolean() }));
  let actions = 0;
  const results = await Streams.from([1, 2, 3])
    .map((_, { signal }) => execution.replay({ signal }), { concurrency: 2 })
    .tap(() => {
      actions++;
    })
    .map((result) => result.value)
    .toArray();
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  await execution.replay(); // The tap handler belongs to the stream, not to this execution.
  assert.equal(actions, 3);
  assert.equal(calls.length, 5);
});

test("collection schema regrouping preserves rounding across provider boundaries", async () => {
  const model: QuestionModel = {
    name: "rounded",
    async evaluate(request) {
      return {
        model: "rounded",
        usage: {},
        rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            {
              type: "score",
              score: 1,
              confidence: 0,
              confidenceSource: "margin",
              probabilities: { "0": 0.33, "1": 0.33, "2": 0.33 },
              legend: { "0": "Low", "1": "Mid", "2": "High" },
            },
          ]),
        ),
      };
    },
  };
  const schema = z
    .number()
    .register(Schema.registry, { kind: "score", levels: ["Low", "Mid", "High"] });
  assert.deepEqual(await Questions.create({ model }).each(["a", "b"]).ask(schema), [1, 1]);
});

test("abortable removes its abort listener immediately even when the user promise never settles", async () => {
  const { abortable, sleep } = await import("../src/internal/abort.ts");
  for (const pending of [true, false]) {
    const controller = new AbortController(),
      signal = controller.signal;
    const add = signal.addEventListener.bind(signal),
      remove = signal.removeEventListener.bind(signal);
    const listeners = new Set<unknown>();
    signal.addEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions,
    ) => {
      if (type === "abort") listeners.add(fn);
      add(type, fn, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      options?: EventListenerOptions,
    ) => {
      if (type === "abort") listeners.delete(fn);
      remove(type, fn, options);
    }) as typeof signal.removeEventListener;
    const work = pending ? abortable(new Promise(() => {}), signal) : sleep(10000, signal);
    assert.equal(listeners.size, 1);
    const cause = new Error("stop");
    controller.abort(cause);
    await assert.rejects(work, (e) => e === cause);
    assert.equal(listeners.size, 0);
  }
});
