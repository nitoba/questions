import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Questions,
  Question,
  TypeSafe,
  Schema,
  Streams,
  SchemaValidationError,
  UncertainDecision,
  TimeoutError,
  ValidationError,
  type DecisionEvent,
  type OperationErrorEvent,
  type SemanticHooks,
  type QuestionModel,
} from "../src/index.ts";
import { fixture, deferred, tick } from "./helpers.ts";

function observed(hooks: SemanticHooks = {}) {
  const { model, calls } = fixture();
  const started: string[] = [],
    decisions: DecisionEvent[] = [],
    errors: OperationErrorEvent[] = [];
  const client = Questions.create({
    model,
    hooks: {
      onEvaluate: (e) => {
        started.push(e.operationId);
      },
      onDecision: (e) => {
        decisions.push(e);
      },
      onError: (e) => {
        errors.push(e);
      },
      ...hooks,
    },
  });
  return { client, calls, started, decisions, errors };
}

test("derived clients snapshot defaults, model methods and callback arrays without mutating parents", async () => {
  const { model } = fixture();
  const invoked: string[] = [];
  const onDecision = [
    () => {
      invoked.push("parent");
    },
  ];
  const defaults = { confidence: 0.5, timeout: "1 s" as const };
  const base = Questions.create({ model, defaults, hooks: { onDecision } });
  defaults.confidence = 1;
  onDecision.push(() => {
    invoked.push("mutated");
  });
  const child = base.extend({
    defaults: { confidence: 0.7, timeout: "2 s" },
    hooks: {
      onDecision: () => {
        invoked.push("child");
      },
    },
  });
  assert.deepEqual(base.defaults, { confidence: 0.5, timeout: 1000 });
  assert.deepEqual(child.defaults, { confidence: 0.7, timeout: 2000 });
  assert.ok(Object.isFrozen(base));
  assert.ok(Object.isFrozen(child.defaults));
  model.evaluate = () => {
    throw new Error("mutation must not replace captured method");
  };
  await base.about("x").is("x");
  await child.about("x").is("x");
  assert.deepEqual(invoked, ["parent", "parent", "child"]);
});

test("call overrides win, omitted values inherit, and schema minimums cannot be weakened", async () => {
  const { model } = fixture();
  const base = Questions.create({ model, defaults: { confidence: 0.99 } });
  await assert.rejects(base.extend().about("x").is("x"), UncertainDecision);
  assert.equal(await base.about("x").is("x", { confidence: 0 }), true);
  const schema = z.boolean().register(Schema.registry, { confidence: 0.95 });
  await assert.rejects(
    base
      .extend({ defaults: { confidence: 0 } })
      .about("x")
      .ask(schema),
    UncertainDecision,
  );
});

test("parent, derived and per-call hooks compose once; false resets hooks explicitly", async () => {
  const { model } = fixture();
  const order: string[] = [];
  const base = Questions.create({
    model,
    hooks: {
      onDecision: () => {
        order.push("base");
      },
    },
  });
  const child = base.extend({
    hooks: {
      onDecision: () => {
        order.push("child");
      },
    },
  });
  await child.about("x").is("x", {
    hooks: {
      onDecision: () => {
        order.push("call");
      },
    },
  });
  assert.deepEqual(order, ["base", "child", "call"]);
  await child.about("x").is("x", { hooks: false });
  await child
    .extend({ hooks: { onDecision: false } })
    .about("x")
    .is("x");
  await child.extend({ hooks: false }).about("x").is("x");
  assert.deepEqual(order, ["base", "child", "call"]);
});

test("every convenience method emits one semantic operation, including batched helpers", async () => {
  const { client, started, decisions, calls } = observed();
  const q = client.about("x");
  await q.ask({ ok: "x" });
  await q.run(z.boolean());
  await q.is("x");
  await q.probability("x");
  await q.score("x", ["a", "b"]);
  await q.evidence({ ok: "x" });
  await q.choose("x", ["a", "b"], (v) => v);
  await q.rank("x", ["a", "b"], (v) => v);
  await q.branch("x", { a: () => 1, b: () => 2 });
  await client.each(["a", "b"]).ask(z.object({ ok: z.boolean() }));
  await client.each(["a", "b"]).is("x");
  await client.each(["a", "b"]).score("x", ["a", "b"]);
  assert.deepEqual(
    decisions.map((e) => e.operation),
    [
      "ask",
      "run",
      "is",
      "probability",
      "score",
      "evidence",
      "choose",
      "rank",
      "branch",
      "each.ask",
      "each.is",
      "each.score",
    ],
  );
  assert.equal(started.length, 12);
  assert.equal(calls.length, 12);
  assert.equal(new Set(started).size, 12);
  for (const event of decisions) {
    assert.equal(event.evaluationCount, 1);
    assert.deepEqual(event.usage, { inputTokens: 12, outputTokens: 3 });
  }
  assert.equal(decisions[9]!.itemCount, 2);
  assert.equal(decisions[9]!.questionCount, 2);
});

test("HTTP retries are not reported as separate semantic operations", async () => {
  let attempts = 0,
    begins = 0,
    ends = 0;
  const model = TypeSafe.create({
    apiKey: "secret",
    retry: { maxRetries: 1, delay: "0 ms" },
    fetch: (async (_url, init) => {
      if (++attempts === 1) return new Response("retry", { status: 429 });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        model: "fixture",
        usage: { input_tokens: 1, output_tokens: 2 },
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 1 }]),
        ),
      });
    }) as typeof fetch,
  });
  await Questions.create({
    model,
    hooks: {
      onEvaluate: () => {
        begins++;
      },
      onDecision: (e) => {
        ends++;
        assert.equal(e.evaluationCount, 1);
      },
    },
  })
    .about("x")
    .is("x");
  assert.equal(attempts, 2);
  assert.equal(begins, 1);
  assert.equal(ends, 1);
});

test("semantic events exclude values, instructions, diagnostics and raw errors", async () => {
  const secret = "private-context-and-key";
  const collected: unknown[] = [];
  const { model } = fixture();
  const client = Questions.create({
    model,
    hooks: {
      onEvaluate: (e) => {
        collected.push(e);
      },
      onDecision: (e) => {
        collected.push(e);
      },
      onError: (e) => {
        collected.push(e);
      },
    },
  });
  await client.about(secret).ask(z.boolean().describe(secret));
  await assert.rejects(
    client.about(secret).ask(z.boolean().refine(() => false, secret)),
    SchemaValidationError,
  );
  assert.ok(!JSON.stringify(collected).includes(secret));
  assert.ok(collected.every(Object.isFrozen));
  assert.equal((collected.at(-1) as OperationErrorEvent).kind, "schema");
  assert.equal((collected.at(-1) as OperationErrorEvent).usage?.inputTokens, 12);
});

test("uncertainty, schema errors and malformed responses emit errors without accepted decisions", async () => {
  const { client, decisions, errors } = observed();
  await assert.rejects(client.about("x").is("x", { confidence: 0.99 }), UncertainDecision);
  await assert.rejects(
    client.about("x").ask(z.boolean().refine(() => false)),
    SchemaValidationError,
  );
  const invalid = client.extend({ model: { name: "broken", evaluate: async () => ({}) } });
  await assert.rejects(invalid.about("x").is("x"), ValidationError);
  assert.equal(decisions.length, 0);
  assert.deepEqual(
    errors.map((e) => e.kind),
    ["uncertain", "schema", "validation"],
  );
  assert.deepEqual(
    errors.map((e) => e.stage),
    ["decision", "validation", "validation"],
  );
});

test("decision hooks run after async transforms and before a selected branch handler", async () => {
  const order: string[] = [];
  const { client, errors } = observed({
    onDecision: () => {
      order.push("decision");
    },
  });
  await client.about("x").ask(
    z.boolean().transform(async (v) => {
      await tick();
      order.push("parse");
      return v;
    }),
  );
  const failure = new Error("handler error");
  await assert.rejects(
    client.about("x").branch("x", {
      a: () => {
        order.push("handler");
        throw failure;
      },
      b: () => 2,
    }),
    (e) => e === failure,
  );
  assert.deepEqual(order, ["parse", "decision", "decision", "handler"]);
  assert.equal(errors.at(-1)?.stage, "handler");
});

test("throwing hooks propagate unchanged and never recursively invoke error hooks", async () => {
  const failure = { callback: "failed" };
  for (const hook of ["onEvaluate", "onDecision"] as const) {
    const { client, calls, errors } = observed({
      [hook]: () => {
        throw failure;
      },
    });
    await assert.rejects(client.about("x").is("x"), (e) => e === failure);
    assert.equal(errors.length, 0);
    assert.equal(calls.length, hook === "onEvaluate" ? 0 : 1);
  }
});

test("operation timeout includes context acquisition and prevents a late provider dispatch", async () => {
  const source = deferred<string>();
  const { model, calls } = fixture();
  const errors: OperationErrorEvent[] = [];
  const client = Questions.create({
    model,
    defaults: { timeout: "5 ms" },
    hooks: {
      onError: (e) => {
        errors.push(e);
      },
    },
  });
  await assert.rejects(client.about(() => source.promise).ask(z.boolean()), TimeoutError);
  source.resolve("late");
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.stage, "context");
});

test("operation deadline includes asynchronous Zod validation, even for constant schemas", async () => {
  const pending = deferred<boolean>();
  const { client, decisions, calls } = observed();
  const value = client.about("x").ask(
    z.literal(true).transform(() => pending.promise),
    { timeout: "5 ms" },
  );
  await assert.rejects(value, TimeoutError);
  pending.reject(new Error("observed late validation"));
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(decisions.length, 0);
});

test("operation deadline covers sequential batch validation rather than resetting per row", async () => {
  const { client, errors } = observed();
  let parses = 0;
  const blocker = deferred<boolean>();
  const schema = z.boolean().transform(() => {
    parses++;
    return blocker.promise;
  });
  await assert.rejects(client.each(["a", "b"]).ask(schema, { timeout: "5 ms" }), TimeoutError);
  blocker.resolve(true);
  await tick();
  assert.equal(parses, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.itemCount, 2);
});

test("timeouts and cancellation settle stalled semantic hooks without later inference", async () => {
  const blocker = deferred<void>();
  const { client, calls, errors } = observed({ onEvaluate: () => blocker.promise });
  await assert.rejects(client.about("x").is("x", { timeout: "5 ms" }), TimeoutError);
  blocker.resolve();
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
});

test("timeout false removes a default budget but leaves a caller signal effective", async () => {
  const { model } = fixture();
  const client = Questions.create({ model, defaults: { timeout: "1 ms" } });
  const child = client.extend({ defaults: { timeout: false } });
  assert.deepEqual(child.defaults, {});
  assert.equal(client.defaults.timeout, 1);
  const source = async () => {
    await new Promise((r) => setTimeout(r, 10));
    return "x";
  };
  assert.equal(await child.about(source).is("x"), true);
  assert.equal(await client.about(source).is("x", { timeout: false }), true);
  const stop = new AbortController();
  const late = deferred<string>();
  const pending = child.about(() => late.promise).is("x", { signal: stop.signal });
  const reason = { stop: true };
  stop.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  late.resolve("late");
});

test("prepare inherits defaults for future runs; replay creates independent IDs, budgets and hooks", async () => {
  const { model } = fixture();
  const events: DecisionEvent[] = [];
  let sources = 0;
  const client = Questions.create({
    model,
    defaults: { confidence: 0.99, timeout: "1s" },
    hooks: {
      onDecision: (e) => {
        events.push(e);
      },
    },
  });
  const prepared = await client
    .about(() => {
      sources++;
      return "x";
    })
    .prepare(z.boolean());
  assert.equal(events.length, 0);
  await assert.rejects(prepared.run(), UncertainDecision);
  const controller = new AbortController();
  const first = await prepared.run({ confidence: 0.5, signal: controller.signal });
  controller.abort();
  const second = await first.replay();
  const third = await second.replay({ hooks: false });
  assert.equal(first.value, true);
  assert.equal(second.value, true);
  assert.equal(third.value, true);
  assert.equal(sources, 1);
  assert.equal(events.length, 2);
  assert.notEqual(first.operationId, second.operationId);
  assert.deepEqual(
    events.map((e) => e.operation),
    ["run", "replay"],
  );
  await assert.rejects(prepared.run(), UncertainDecision);
});

test("pre-abort performs no context, inference or hooks; owned timers are disposed on success", async () => {
  const { client, started, errors, decisions } = observed();
  let sources = 0;
  const controller = new AbortController();
  controller.abort("stop");
  await assert.rejects(
    client
      .about(() => {
        sources++;
        return "x";
      })
      .is("x", { signal: controller.signal }),
    (e) => e === "stop",
  );
  assert.equal(sources, 0);
  assert.equal(started.length, 0);
  assert.equal(errors.length, 0);
  await client.about("x").is("x", { timeout: "5 ms" });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(decisions[0]!.signal.aborted, false);
});

test("cancellation error hooks cannot stall the caller or leak late promise rejections", async () => {
  const stopped = new AbortController();
  const pendingSource = deferred<string>();
  const hook = deferred<void>();
  let errors = 0;
  const { client } = observed({
    onError: () => {
      errors++;
      return hook.promise;
    },
  });
  const result = client.about(() => pendingSource.promise).is("x", { signal: stopped.signal });
  stopped.abort("caller-stop");
  await assert.rejects(result, (e) => e === "caller-stop");
  assert.equal(errors, 1);
  hook.reject(new Error("late hook"));
  pendingSource.resolve("late");
  await tick();
});

test("concurrent streams retain distinct operation scopes without multiplying callbacks", async () => {
  const { client, started, decisions } = observed();
  const values = await Streams.from(["a", "b", "c"])
    .map((item, { signal }) => client.about(item).run(z.boolean(), { signal }), { concurrency: 3 })
    .toArray();
  assert.equal(values.length, 3);
  assert.equal(new Set(started).size, 3);
  assert.equal(decisions.length, 3);
  assert.deepEqual(new Set(values.map((v) => v.operationId)), new Set(started));
});

test("invalid defaults fail eagerly and raw probability/evidence do not apply confidence gates", async () => {
  const { model, calls } = fixture();
  for (const defaults of [
    { confidence: NaN },
    { confidence: null },
    { timeout: "typo" },
    { timeout: "1 s", timeoutMs: 1 },
    { signal: new AbortController().signal },
  ])
    assert.throws(
      () =>
        Questions.create({ model, defaults } as unknown as Parameters<typeof Questions.create>[0]),
      ValidationError,
    );
  const client = Questions.create({ model, defaults: { confidence: 1 } });
  assert.equal(await client.about("x").probability("x"), 0.9);
  assert.equal((await client.about("x").evidence({ ok: "x" })).answers.ok.probability, 0.9);
  assert.equal(calls.length, 2);
});

test("call policies are captured before an awaited hook can mutate the caller's options", async () => {
  const waiting = deferred<void>();
  const { model } = fixture();
  const client = Questions.create({ model, hooks: { onEvaluate: () => waiting.promise } });
  const options = { confidence: 0.5, timeout: "1 s" as const };
  const pending = client.about("x").is("x", options);
  options.confidence = 1;
  waiting.resolve();
  assert.equal(await pending, true);
});

test("constant and empty evaluations report zero inference while still validating outputs", async () => {
  const { client, decisions, calls } = observed();
  await client.about("x").ask(z.literal("x"));
  await client.each([]).ask(z.boolean());
  assert.equal(calls.length, 0);
  assert.deepEqual(
    decisions.map((e) => e.evaluationCount),
    [0, 0],
  );
  assert.deepEqual(
    decisions.map((e) => e.itemCount),
    [1, 0],
  );
  assert.deepEqual(
    decisions.map((e) => e.usage),
    [undefined, undefined],
  );
});

test("explicit model changes on a derived client or replay preserve the parent and callback binding", async () => {
  const { model } = fixture();
  let uses = 0;
  const second: QuestionModel & { tag: string } = {
    name: "second",
    tag: "bound",
    async evaluate(request) {
      assert.equal(this.tag, "bound");
      uses++;
      return {
        model: "second",
        usage: {},
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "boolean", probability: 0 }]),
        ),
      };
    },
  };
  const base = Questions.create({ model });
  const child = base.extend({ model: second });
  assert.equal(await base.about("x").is("x"), true);
  assert.equal(await child.about("x").is("x"), false);
  const first = await base.about("x").run({ ok: Question.boolean("x") });
  assert.equal((await first.replay({ model: second })).value.ok, false);
  assert.equal(uses, 2);
});

test("expired monotonic deadlines prevent dispatch after synchronous hooks and context callbacks", async () => {
  const busy = () => {
    const until = performance.now() + 15;
    while (performance.now() < until) {
      /* Intentional event-loop blocking regression fixture. */
    }
  };
  const { model, calls } = fixture();
  const hooks = Questions.create({
    model,
    defaults: { timeout: "5 ms" },
    hooks: { onEvaluate: busy },
  });
  await assert.rejects(hooks.about("x").is("x"), TimeoutError);
  assert.equal(calls.length, 0);
  const contexts = Questions.create({ model, defaults: { timeout: "5 ms" } });
  await assert.rejects(
    contexts
      .about(() => {
        busy();
        return "x";
      })
      .is("x"),
    TimeoutError,
  );
  await assert.rejects(
    contexts
      .about(() => {
        busy();
        return "x";
      })
      .evidence({ ok: "x" }),
    TimeoutError,
  );
  assert.equal(calls.length, 0);
});

test("synchronous Zod work exceeding the operation budget does not start decision hooks or another batch row", async () => {
  const { model } = fixture();
  let parses = 0,
    decisions = 0;
  const client = Questions.create({
    model,
    defaults: { timeout: "5 ms" },
    hooks: {
      onDecision: () => {
        decisions++;
      },
    },
  });
  const schema = z.boolean().transform((value) => {
    parses++;
    const until = performance.now() + 15;
    while (performance.now() < until) {
      /* Intentional CPU-bound user transform. */
    }
    return value;
  });
  await assert.rejects(client.each(["a", "b"]).ask(schema), TimeoutError);
  assert.equal(parses, 1);
  assert.equal(decisions, 0);
});

test("a failing or timed-out decision hook prevents the selected branch handler", async () => {
  const { model } = fixture();
  let handlers = 0;
  const marker = new Error("decision hook failure");
  const client = Questions.create({ model });
  const branches = {
    a: () => {
      handlers++;
    },
    b: () => {
      handlers++;
    },
  };
  await assert.rejects(
    client.about("x").branch("x", branches, {
      hooks: {
        onDecision: () => {
          throw marker;
        },
      },
    }),
    (error) => error === marker,
  );
  await assert.rejects(
    client.about("x").branch("x", branches, {
      timeout: "5 ms",
      hooks: { onDecision: () => new Promise(() => {}) },
    }),
    TimeoutError,
  );
  assert.equal(handlers, 0);
});

test("invalid context reports zero evaluations and the context stage", async () => {
  const { client, calls, errors } = observed();
  await assert.rejects(
    client.about({ invalid: Number.NaN }).evidence({ ok: "x" }),
    ValidationError,
  );
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.stage, "context");
  assert.equal(errors[0]!.evaluationCount, 0);
});

test("evidence checks its deadline after snapshotting user context before dispatch", async () => {
  const { client, calls, errors } = observed();
  const source = {
    get content() {
      const until = performance.now() + 15;
      while (performance.now() < until) {
        /* An enumerable application getter runs during the JSON snapshot. */
      }
      return "context";
    },
  };
  await assert.rejects(
    client.about(source).evidence({ ok: "x" }, { timeout: "5 ms" }),
    TimeoutError,
  );
  assert.equal(calls.length, 0);
  assert.equal(errors[0]!.evaluationCount, 0);
});
