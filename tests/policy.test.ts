import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as mini from "zod/mini";
import {
  Policy,
  Question,
  Questions,
  Schema,
  Streams,
  UncertainPolicyError,
  UncertainDecision,
  SchemaValidationError,
  ValidationError,
  TimeoutError,
  type QuestionModel,
  type AnyQuestion,
  type DecisionEvent,
  type OperationErrorEvent,
} from "../src/index.ts";
import { fixture, deferred } from "./helpers.ts";

const options = { thresholds: { accept: 0.8, reject: 0.2 } };
const definitions = {
  impact: Question.choice("Impact?", { none: "No API change", breaking: "Existing callers break" }),
  regression: Question.boolean("Regression risk?"),
};
const review = Policy.from(definitions, options)
  .when(
    ({ impact, regression }) => impact.is("breaking").and(regression.is(true, { reject: 0.5 })),
    "block",
  )
  .when(({ impact }) => impact.is("breaking"), "migration-required")
  .onUncertain("human-review")
  .otherwise("ship");

function choice(probabilities: Record<string, number>, confidence = 1) {
  return {
    type: "choice",
    choice: Object.keys(probabilities).sort((a, b) => probabilities[b]! - probabilities[a]!)[0]!,
    probabilities,
    confidence,
    probabilitySource: "custom",
  };
}
function answers(breaking: number, regression: number) {
  return fixture((question) =>
    question.type === "boolean"
      ? { type: "boolean", probability: regression, probabilitySource: "estimated" }
      : choice({ none: 1 - breaking, breaking }),
  );
}

for (const [breaking, regression, expected] of [
  [0.94, 0.91, "block"],
  [0.94, 0.35, "migration-required"],
  [0.94, 0.62, "human-review"],
  [0.05, 0.62, "ship"],
] as const) {
  test(`policy priority: ${breaking}/${regression} -> ${expected}`, async () => {
    const provider = answers(breaking, regression);
    const execution = await Questions.create(provider).about({ diff: "change" }).run(review);
    assert.equal(execution.value, expected);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(Object.keys(provider.calls[0]!.questions), ["impact", "regression"]);
    assert.equal(
      execution.trace.rules.length,
      expected === "block" || expected === "human-review" ? 1 : 2,
    );
    assert.equal(
      execution.trace.selected.kind,
      expected === "ship" ? "otherwise" : expected === "human-review" ? "uncertain" : "rule",
    );
    assert.equal(execution.evidence!.answers.regression.probabilitySource, "estimated");
  });
}

test("construction executes each rule callback once, performs no inference and shares repeated questions", async () => {
  let built = 0;
  const provider = fixture();
  const builder = Policy.from({ ready: "Ready?" }, options);
  const policy = builder
    .when(({ ready }) => {
      built++;
      return ready.is(true);
    }, "yes")
    .when(({ ready }) => {
      built++;
      return ready.is(false);
    }, "no")
    .otherwise("other");
  assert.equal(built, 2);
  assert.equal(provider.calls.length, 0);
  const q = Questions.create(provider).about("context");
  assert.equal(await q.decide(policy), "yes");
  assert.equal(await q.decide(policy), "yes");
  assert.equal(built, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(Object.keys(provider.calls[0]!.questions).length, 1);
  assert.ok(Object.isFrozen(builder));
  assert.ok(Object.isFrozen(policy));
});

for (const [p, expected] of [
  [0.8, "yes"],
  [0.2, "no"],
  [0.5, "uncertain"],
  [0.79999, "uncertain"],
  [0.20001, "uncertain"],
] as const) {
  test(`inclusive policy boundaries at ${p}`, async () => {
    const policy = Policy.from({ ready: "Ready?" }, options)
      .when(({ ready }) => ready.is(true), "yes")
      .onUncertain("uncertain")
      .otherwise("no");
    assert.equal(
      await Questions.create(fixture(() => ({ type: "boolean", probability: p })))
        .about("x")
        .decide(policy),
      expected,
    );
  });
}

for (const a of ["match", "miss", "uncertain"] as const)
  for (const b of ["match", "miss", "uncertain"] as const) {
    test(`three-valued composition ${a}/${b}`, async () => {
      const probability = { match: 0.9, miss: 0.1, uncertain: 0.5 };
      const provider = fixture((_, key) => ({
        type: "boolean",
        probability: probability[key === "a" ? a : b],
      }));
      const builder = Policy.from({ a: "A?", b: "B?" }, options);
      const and = builder
        .when(({ a, b }) => a.is(true).and(b.is(true)), "match")
        .onUncertain("uncertain")
        .otherwise("miss");
      const or = builder
        .when(({ a, b }) => a.is(true).or(b.is(true)), "match")
        .onUncertain("uncertain")
        .otherwise("miss");
      const q = Questions.create(provider).about("x");
      assert.equal(
        await q.decide(and),
        a === "miss" || b === "miss"
          ? "miss"
          : a === "uncertain" || b === "uncertain"
            ? "uncertain"
            : "match",
      );
      assert.equal(
        await q.decide(or),
        a === "match" || b === "match"
          ? "match"
          : a === "uncertain" || b === "uncertain"
            ? "uncertain"
            : "miss",
      );
      const negated = builder
        .when(({ a }) => a.is(true).not(), "match")
        .onUncertain("uncertain")
        .otherwise("miss");
      assert.equal(
        await q.decide(negated),
        a === "match" ? "miss" : a === "miss" ? "match" : "uncertain",
      );
    });
  }

test("oneOf sums distinct outcome mass, not the winning label; comparisons tolerate arithmetic rounding", async () => {
  const policy = Policy.from(
    { impact: Question.choice("Impact?", { additive: "A", behavioral: "B", breaking: "C" }) },
    options,
  )
    .when(({ impact }) => impact.oneOf(["behavioral", "breaking", "breaking"]), "attention")
    .otherwise("none");
  const execution = await Questions.create(
    fixture(() => choice({ additive: 0.2, behavioral: 0.1, breaking: 0.7 })),
  )
    .about("x")
    .run(policy);
  assert.equal(execution.value, "attention");
  const leaf = execution.trace.rules[0]!.condition;
  assert.equal(leaf.type, "question");
  if (leaf.type === "question") assert.deepEqual(leaf.expected, ["behavioral", "breaking"]);
});

test("boolean false evaluates complementary mass, and unknown provenance stays unknown", async () => {
  const policy = Policy.from({ ready: "Ready?" }, options)
    .when(({ ready }) => ready.is(false), "no")
    .otherwise("yes");
  const execution = await Questions.create(fixture(() => ({ type: "boolean", probability: 0.2 })))
    .about("x")
    .run(policy);
  assert.equal(execution.value, "no");
  assert.ok(!Object.hasOwn(execution.trace.rules[0]!.condition, "probabilitySource"));
});

function score(question: AnyQuestion, probabilities: Record<string, number>) {
  assert.equal(question.type, "score");
  if (question.type !== "score") throw new Error("expected rubric");
  return {
    type: "score",
    score: Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0),
    probabilities,
    confidence: 1,
    legend: Object.fromEntries(question.criteria.map((value, i) => [String(i), value])),
  };
}
test("score predicates use probability mass over levels rather than the weighted score", async () => {
  const builder = Policy.from(
    { urgency: Question.score("Urgent?", ["Low", "Medium", "High"]) },
    options,
  );
  const policy = builder
    .when(({ urgency }) => urgency.atLeast(1).and(urgency.atMost(2)), "urgent")
    .onUncertain("review")
    .otherwise("normal");
  const execution = await Questions.create(fixture((q) => score(q, { 0: 0.1, 1: 0.1, 2: 0.8 })))
    .about("x")
    .run(policy);
  assert.equal(execution.value, "urgent");
  assert.ok(Math.abs(execution.evidence!.answers.urgency.score - 1.7) < 1e-12);
  const impossible = builder.when(({ urgency }) => urgency.atLeast(3), "yes").otherwise("no");
  assert.equal(await Questions.create(fixture()).about("x").decide(impossible), "no");
});

test("cutoffs and definitions are snapshotted; builder derivations are independent", async () => {
  const settings = { thresholds: { accept: 0.8, reject: 0.2 } };
  const batch = { ready: "Ready?" };
  const builder = Policy.from(batch, settings);
  const result = { action: "go", metadata: { version: 1 } };
  const first = builder.when(({ ready }) => ready.is(true), result).otherwise(null);
  const second = builder.otherwise("always");
  settings.thresholds.accept = 1;
  batch.ready = "Changed?";
  result.metadata.version = 2;
  const provider = fixture();
  const q = Questions.create(provider).about("x");
  const value = await q.decide(first);
  assert.deepEqual(value, { action: "go", metadata: { version: 1 } });
  assert.ok(Object.isFrozen(value!.metadata));
  assert.equal(await q.decide(second), "always");
  assert.equal(provider.calls[0]!.questions.ready!.instructions, "Ready?");
});

test("undefined is an explicit uncertainty result, not an absent fallback", async () => {
  const policy = Policy.from({ ready: "Ready?" }, options)
    .when(({ ready }) => ready.is(true), "go")
    .onUncertain(undefined)
    .otherwise("stop");
  assert.equal(
    await Questions.create(fixture(() => ({ type: "boolean", probability: 0.5 })))
      .about("x")
      .decide(policy),
    undefined,
  );
});

test("unhandled policy uncertainty retains a frozen trace and evidence", async () => {
  const policy = Policy.from({ ready: "Ready?" }, options)
    .when(({ ready }) => ready.is(true), "go")
    .otherwise("stop");
  await assert.rejects(
    Questions.create(fixture(() => ({ type: "boolean", probability: 0.5 })))
      .about("x")
      .decide(policy),
    (error) => {
      assert.ok(error instanceof UncertainPolicyError);
      assert.deepEqual(error.trace.selected, { kind: "uncertain", index: 0 });
      assert.ok(Object.isFrozen(error.trace.rules[0]!.condition));
      assert.ok(Object.isFrozen(error.evidence!.answers));
      return true;
    },
  );
});

test("invalid thresholds, labels, empty groups and non-finite score bounds fail during construction", () => {
  for (const limits of [
    { accept: NaN, reject: 0.2 },
    { accept: 0.5, reject: 0.5 },
    { accept: Infinity, reject: 0 },
    { accept: 1.1, reject: 0 },
    { accept: 0.8, reject: -0.1 },
  ])
    assert.throws(() => Policy.from(definitions, { thresholds: limits }), ValidationError);
  const builder = Policy.from(definitions, options);
  assert.throws(() => builder.when(({ impact }) => impact.oneOf([]), "x"), ValidationError);
  // @ts-expect-error runtime validation protects JS callers as well
  assert.throws(() => builder.when(({ impact }) => impact.is("unknown"), "x"), ValidationError);
  assert.throws(
    // @ts-expect-error null must not inherit a cutoff
    () => builder.when(({ regression }) => regression.is(true, { accept: null }), "x"),
    ValidationError,
  );
  const numeric = Policy.from({ score: Question.score("Score?", ["A", "B"]) }, options);
  assert.throws(() => numeric.when(({ score }) => score.atLeast(NaN), "x"), ValidationError);
  assert.throws(() => builder.onUncertain("x").onUncertain("y"), ValidationError);
});

test("rule callbacks must return owned conditions synchronously and values must not be handlers", () => {
  const builder = Policy.from({ ready: "Ready?" }, options);
  let foreign!: Policy.Condition;
  builder.when(({ ready }) => {
    foreign = ready.is(true);
    return foreign;
  }, "yes");
  const other = Policy.from({ ready: "Ready?" }, options);
  assert.throws(() => other.when(() => foreign, "yes"), ValidationError);
  assert.throws(
    () => other.when(({ ready }) => ready.is(true).and(foreign), "yes"),
    ValidationError,
  );
  // @ts-expect-error a boolean is not a condition
  assert.throws(() => builder.when(() => true, "yes"), ValidationError);
  // @ts-expect-error asynchronous construction is not supported
  assert.throws(() => builder.when(async ({ ready }) => ready.is(true), "yes"), ValidationError);
  assert.throws(
    () =>
      builder.when(
        ({ ready }) => ready.is(true),
        // @ts-expect-error policy results are data, never callbacks
        () => "yes",
      ),
    ValidationError,
  );
  // @ts-expect-error policy results are data, never promises
  assert.throws(() => builder.otherwise(Promise.resolve("yes")), ValidationError);
});

test("native confidence gates remain hard constraints rather than onUncertain results", async () => {
  const policy = Policy.from({ ready: "Ready?" }, options)
    .when(({ ready }) => ready.is(true), "go")
    .onUncertain("review")
    .otherwise("stop");
  const client = Questions.create({ ...fixture(), defaults: { confidence: 0.99 } });
  await assert.rejects(client.about("x").decide(policy), UncertainDecision);
  assert.equal(await client.about("x").decide(policy, { confidence: 0.5 }), "go");
});

test("Zod policies preserve option mappings, input paths, score mass and async refinements", async () => {
  let parsed = 0;
  const schema = z
    .object({
      "nested.impact": z.enum(["none", "breaking"]),
      nested: z.object({ urgent: z.boolean() }),
      score: Schema.annotate(z.number(), { kind: "score", levels: ["Low", "Medium", "High"] }),
      pair: z.tuple([z.boolean(), z.union([z.literal(10), z.literal(20)])]),
    })
    .refine(async () => {
      parsed++;
      return true;
    })
    .readonly();
  const policy = Policy.from(schema, options)
    .when(
      (refs) =>
        refs["nested.impact"]
          .is("breaking")
          .and(refs.nested.urgent.is(true))
          .and(refs.score.atLeast(1))
          .and(refs.pair[0].is(true))
          .and(refs.pair[1].is(20)),
      "go",
    )
    .otherwise("stop");
  const provider = fixture((question) => {
    if (question.type === "boolean") return { type: "boolean", probability: 0.95 };
    if (question.type === "score") return score(question, { 0: 0.05, 1: 0.05, 2: 0.9 });
    return choice({ o0: 0.05, o1: 0.95 });
  });
  assert.equal(parsed, 0);
  const execution = await Questions.create(provider).about("x").run(policy);
  assert.equal(execution.value, "go");
  assert.equal(parsed, 1);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(
    execution.diagnostics.map((field) => field.path),
    [["nested.impact"], ["nested", "urgent"], ["score"], ["pair", 0], ["pair", 1]],
  );
  await execution.replay();
  assert.equal(parsed, 2);
});

test("Zod Mini uses the same policy API", async () => {
  const policy = Policy.from(mini.object({ ready: mini.boolean() }), options)
    .when(({ ready }) => ready.is(true), "go")
    .otherwise("stop");
  assert.equal(await Questions.create(fixture()).about("x").decide(policy), "go");
});

test("constant schema policies skip context and inference but keep local validation", async () => {
  let reads = 0,
    parsed = 0;
  const schema = z.object({ mode: z.literal("safe") }).refine(() => {
    parsed++;
    return true;
  });
  const policy = Policy.from(schema, options)
    .when(({ mode }) => mode.is("safe"), "go")
    .otherwise("stop");
  const provider = fixture();
  const execution = await Questions.create(provider)
    .about(() => {
      reads++;
      return "x";
    })
    .run(policy);
  assert.equal(execution.value, "go");
  assert.equal(execution.evidence, undefined);
  assert.equal(reads, 0);
  assert.equal(parsed, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(execution.trace.rules[0]!.condition.type, "constant");
});

test("schema confidence gates and refinements run before selecting policy results", async () => {
  let parsed = 0;
  const schema = z
    .object({ ready: z.boolean().register(Schema.registry, { confidence: 0.95 }) })
    .refine(() => {
      parsed++;
      return true;
    });
  const policy = Policy.from(schema, options)
    .when(({ ready }) => ready.is(true), "go")
    .onUncertain("review")
    .otherwise("stop");
  await assert.rejects(
    Questions.create(fixture()).about("x").decide(policy, { confidence: 0 }),
    UncertainDecision,
  );
  assert.equal(parsed, 0);
  const rejected = Policy.from(
    z.object({ ready: z.boolean() }).refine(() => false),
    options,
  ).otherwise("result");
  await assert.rejects(
    Questions.create(fixture()).about("x").decide(rejected),
    SchemaValidationError,
  );
});

test("unsupported Zod transforms and presence wrappers are rejected before inference/callbacks", () => {
  let callbacks = 0;
  const fields = [
    z.boolean().optional(),
    z.boolean().nullable(),
    z.boolean().default(true),
    z.boolean().catch(true),
    z.boolean().transform((value) => {
      callbacks++;
      return !value;
    }),
    z.boolean().overwrite((value) => {
      callbacks++;
      return !value;
    }),
    Schema.annotate(z.number(), { kind: "probability" }),
  ];
  for (const field of fields)
    assert.throws(() => Policy.from(z.object({ value: field }), options), ValidationError);
  assert.throws(
    () =>
      Policy.from(
        z.object({ ready: z.boolean() }).transform((value) => ({ changed: value.ready })),
        options,
      ),
    ValidationError,
  );
  assert.equal(callbacks, 0);
});

test("the whole provider batch is validated before Zod callbacks or policy selection", async () => {
  let parsed = 0;
  const schema = z.object({ ready: z.boolean(), ignored: z.boolean() }).refine(() => {
    parsed++;
    return true;
  });
  const policy = Policy.from(schema, options)
    .when(({ ready }) => ready.is(true), "go")
    .onUncertain("review")
    .otherwise("stop");
  const provider = fixture((_, key) => ({
    type: "boolean",
    probability: key === "q0" ? 0.99 : NaN,
  }));
  await assert.rejects(Questions.create(provider).about("x").decide(policy), ValidationError);
  assert.equal(parsed, 0);
});

test("policy errors do not become fallback values and do not cause retries", async () => {
  const failure = new Error("provider failed");
  let calls = 0;
  const model: QuestionModel = {
    name: "failing",
    evaluate() {
      calls++;
      throw failure;
    },
  };
  await assert.rejects(
    Questions.create({ model }).about("x").decide(review),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("replay preserves the policy and captured state but not prior signals or provider", async () => {
  let reads = 0;
  const controller = new AbortController();
  const original = answers(0.94, 0.91);
  const execution = await Questions.create(original)
    .about(() => ({ revision: ++reads }))
    .run(review, { signal: controller.signal });
  controller.abort();
  const next = answers(0.05, 0.9);
  const replay = await execution.replay({ model: next.model });
  assert.equal(replay.value, "ship");
  assert.equal(reads, 1);
  assert.deepEqual(next.calls[0]!.state, { revision: 1 });
  assert.notEqual(replay.operationId, execution.operationId);
  assert.deepEqual(replay.trace.selected, { kind: "otherwise" });
});

test("policy cancellation closes context/inference scopes and timeout is not uncertainty", async () => {
  let reads = 0;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const provider = fixture();
  await assert.rejects(
    Questions.create(provider)
      .about(() => {
        reads++;
        return "x";
      })
      .decide(review, { signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  assert.equal(reads, 0);
  assert.equal(provider.calls.length, 0);
  const started = deferred<void>();
  let signal: AbortSignal | undefined;
  const model: QuestionModel = {
    name: "waiting",
    evaluate(_request, context) {
      signal = context?.signal;
      started.resolve();
      return new Promise(() => {});
    },
  };
  const request = Questions.create({ model }).about("x").decide(review, { timeout: "30 ms" });
  await started.promise;
  await assert.rejects(request, TimeoutError);
  assert.equal(signal?.aborted, true);
});

test("decide, run and replay emit one lifecycle each without leaking policy traces or values", async () => {
  const starts: string[] = [],
    decisions: DecisionEvent[] = [],
    errors: OperationErrorEvent[] = [];
  const client = Questions.create({
    ...answers(0.94, 0.91),
    hooks: {
      onEvaluate: (e) => {
        starts.push(e.operation);
      },
      onDecision: (e) => {
        decisions.push(e);
      },
      onError: (e) => {
        errors.push(e);
      },
    },
  });
  await client.about("sensitive-diff").decide(review);
  const result = await client.about("sensitive-diff").run(review);
  await result.replay();
  assert.deepEqual(starts, ["decide", "run", "replay"]);
  assert.deepEqual(
    decisions.map((e) => [e.evaluationCount, e.questionCount]),
    [
      [1, 2],
      [1, 2],
      [1, 2],
    ],
  );
  assert.ok(!JSON.stringify(decisions).includes("sensitive-diff"));
  assert.ok(decisions.every((e) => !Object.hasOwn(e, "trace") && !Object.hasOwn(e, "value")));
  const unhandled = Policy.from({ ready: "Ready?" }, options)
    .when(({ ready }) => ready.is(true), "go")
    .otherwise("stop");
  const uncertain = client.extend({
    model: fixture(() => ({ type: "boolean", probability: 0.5 })).model,
  });
  await assert.rejects(uncertain.about("x").decide(unhandled), UncertainPolicyError);
  assert.equal(errors[0]!.kind, "uncertain");
  assert.equal(errors[0]!.stage, "decision");
});

test("policies compose with bounded Streams without introducing another executor", async () => {
  const provider = answers(0.94, 0.91);
  const client = Questions.create(provider);
  const values = await Streams.from(["a", "b", "c"])
    .map((input, { signal }) => client.about(input).decide(review, { signal }), { concurrency: 2 })
    .toArray();
  assert.deepEqual(values, ["block", "block", "block"]);
  assert.equal(provider.calls.length, 3);
});

test("rejected async condition callbacks are observed without accepting async construction", async () => {
  const builder = Policy.from({ ready: "Ready?" }, options);
  const invalid = async () => {
    throw new Error("invalid async callback");
  };
  assert.throws(
    // @ts-expect-error JavaScript callers receive a construction error, never an unhandled rejection
    () => builder.when(invalid, "act"),
    ValidationError,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
