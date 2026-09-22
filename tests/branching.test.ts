import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  Questions,
  Policy,
  Question,
  ValidationError,
  UncertainDecision,
  UncertainBranchError,
  UnmatchedBranchError,
  TimeoutError,
  type BranchOptions,
  type Branches,
  type DecisionEvent,
  type OperationErrorEvent,
  type QuestionModel,
} from "../src/index.ts";
import { fixture, deferred } from "./helpers.ts";

function answer(probabilities: Record<string, number>, choice?: string, confidence = 1) {
  return {
    type: "choice",
    confidence,
    probabilitySource: "estimated",
    probabilities,
    choice:
      choice ??
      Object.keys(probabilities).sort((a, b) => probabilities[b]! - probabilities[a]!)[0]!,
  };
}
const descriptors = {
  review: { description: "Assess release safety", run: () => "review" },
  explain: { description: "Return the available summary", run: () => "explain" },
};

test("descriptive branches send only intent and routing guidance, invoking one local handler", async () => {
  const request = {
    ask: "Is this safe to release?",
    diff: "PRIVATE-DIFF",
    apiKey: "private-test-data",
  };
  let invoked = 0;
  const provider = fixture(() => answer({ review: 0.9, explain: 0.1 }));
  const result = await Questions.create(provider)
    .about(request.ask)
    .branch(
      "Which operation?",
      {
        review: {
          description: "Assess release safety",
          examples: ["Is this safe?"],
          run: ({ signal }) => {
            invoked++;
            assert.equal(signal.aborted, false);
            return request.diff;
          },
        },
        explain: {
          description: "Summarize",
          run: () => {
            throw new Error("not selected");
          },
        },
      },
      { selection: { minProbability: 0.8, minMargin: 0.2 } },
    );
  assert.equal(result, request.diff);
  assert.equal(invoked, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]!.state, request.ask);
  const sent = provider.calls[0]!.questions.answer;
  assert.equal(sent?.type, "choice");
  if (sent?.type === "choice")
    assert.deepEqual(sent.criteria.review, {
      description: "Assess release safety",
      examples: ["Is this safe?"],
    });
  const wire = JSON.stringify(provider.calls);
  assert.ok(!wire.includes(request.diff));
  assert.ok(!wire.includes(request.apiKey));
  assert.ok(!wire.includes('"run"'));
  assert.ok(!wire.includes('"enabled"'));
});

test("function-only branches preserve the old declared-winner tie behavior and key guidance", async () => {
  const provider = fixture(() => answer({ a: 0.5, b: 0.5 }, "b"));
  const q = Questions.create(provider).about("x");
  assert.equal(await q.branch("Route?", { a: () => "a", b: async () => "b" }), "b");
  const question = provider.calls[0]!.questions.answer;
  if (question?.type === "choice") assert.deepEqual(question.criteria, { a: "a", b: "b" });
  await assert.rejects(q.branch("Route?", {}), ValidationError);
  await assert.rejects(q.branch("Route?", { a: () => "a" }), ValidationError);
  assert.equal(provider.calls.length, 1);
});

test("new routing criteria are available to function maps without forcing descriptor boilerplate", async () => {
  const provider = fixture(() => answer({ a: 0.5, b: 0.5 }));
  let reason = "";
  const result = await Questions.create(provider)
    .about("x")
    .branch(
      "Route?",
      { a: () => 1, b: () => 2 },
      {
        onUncertain: (context) => {
          reason = context.reason;
          return "ask";
        },
      },
    );
  assert.equal(result, "ask");
  assert.equal(reason, "tie");
});

for (const [a, b, minProbability, minMargin, expected] of [
  [0.5, 0.5, 0, 0, "tie"],
  [0.6, 0.4, 0.8, 0, "min-probability"],
  [0.7, 0.3, 0.7, 0.5, "min-margin"],
  [0.7, 0.3, 0.7, 0.4, "review"],
] as const) {
  test(`routing probability ${a}, margin ${minMargin} -> ${expected}`, async () => {
    const provider = fixture(() => answer({ review: a, explain: b }));
    const result = await Questions.create(provider)
      .about("x")
      .branch("Route?", descriptors, {
        selection: { minProbability, minMargin },
        onUncertain: (context) => {
          assert.ok(Object.isFrozen(context));
          assert.ok(Object.isFrozen(context.ranked));
          assert.ok(context.ranked.every(Object.isFrozen));
          assert.ok(Object.isFrozen(context.evidence));
          assert.equal(context.evidence.probabilitySource, "estimated");
          return context.reason;
        },
      });
    assert.equal(result, expected);
  });
}

test("a rejection alternative returns unmatched only when it meets the same acceptance criteria", async () => {
  const q = Questions.create(
    fixture(() => answer({ review: 0.05, explain: 0.05, __unmatched__: 0.9 })),
  ).about("What is the weather?");
  const result = await q.branch("Route?", descriptors, {
    selection: { allowUnmatched: true, minProbability: 0.8, minMargin: 0.2 },
    onUnmatched: (context) => {
      assert.equal(context.reason, "unmatched");
      assert.deepEqual(context.ranked[0], { id: null, probability: 0.9 });
      assert.equal(context.evidence?.probabilitySource, "estimated");
      return "unsupported";
    },
  });
  assert.equal(result, "unsupported");
  const ambiguous = Questions.create(
    fixture(() => answer({ review: 0.3, explain: 0.3, __unmatched__: 0.4 })),
  ).about("x");
  assert.equal(
    await ambiguous.branch("Route?", descriptors, {
      selection: { allowUnmatched: true, minProbability: 0.8 },
      onUncertain: () => "ask",
      onUnmatched: () => {
        throw new Error("ambiguous rejection must not become unmatched");
      },
    }),
    "ask",
  );
});

test("unhandled route uncertainty and unmatched requests have distinct typed errors", async () => {
  await assert.rejects(
    Questions.create(fixture(() => answer({ review: 0.5, explain: 0.5 })))
      .about("x")
      .branch("Route?", descriptors),
    (error: unknown) => {
      assert.ok(error instanceof UncertainBranchError);
      assert.equal(error.details.reason, "tie");
      assert.ok(!Object.hasOwn(error.details, "signal"));
      return true;
    },
  );
  await assert.rejects(
    Questions.create(fixture(() => answer({ review: 0, explain: 0, __unmatched__: 1 })))
      .about("x")
      .branch("Route?", descriptors, {
        selection: { allowUnmatched: true },
      }),
    (error: unknown) => {
      assert.ok(error instanceof UnmatchedBranchError);
      assert.equal(error.details.reason, "unmatched");
      return true;
    },
  );
});

test("no enabled operations skip context and inference, with an explicit unavailable result", async () => {
  const provider = fixture();
  const q = Questions.create(provider).about(() => {
    throw new Error("must not read context");
  });
  const branches = {
    disabled: {
      description: "Unavailable operation",
      enabled: false,
      run: () => {
        throw new Error("must not execute");
      },
    },
  };
  assert.equal(
    await q.branch("Route?", branches, {
      onUnmatched: (context) => {
        assert.equal(context.reason, "unavailable");
        assert.equal(context.evidence, undefined);
        assert.deepEqual(context.ranked, []);
        return "unavailable";
      },
    }),
    "unavailable",
  );
  await assert.rejects(q.branch("Route?", branches), UnmatchedBranchError);
  assert.equal(
    await q.branch(
      "Route?",
      {},
      { selection: { allowUnmatched: true }, onUnmatched: () => "empty" },
    ),
    "empty",
  );
  assert.equal(provider.calls.length, 0);
});

test("a single enabled branch competes against rejection, never wins by elimination", async () => {
  const provider = fixture(() => answer({ review: 0.1, __unmatched__: 0.9 }));
  const q = Questions.create(provider).about("unrelated request");
  const branches = {
    review: descriptors.review,
    explain: { ...descriptors.explain, enabled: false },
  };
  await assert.rejects(q.branch("Route?", branches), /allowUnmatched/);
  assert.equal(provider.calls.length, 0);
  assert.equal(
    await q.branch("Route?", branches, {
      selection: { allowUnmatched: true },
      onUnmatched: () => "unsupported",
    }),
    "unsupported",
  );
  assert.equal(provider.calls.length, 1);
  const question = provider.calls[0]!.questions.answer;
  assert.equal(question?.type, "choice");
  if (question?.type === "choice")
    assert.deepEqual(Object.keys(question.criteria), ["review", "__unmatched__"]);
});

test("internal rejection IDs do not collide with application keys, even disabled ones", async () => {
  const provider = fixture((q) => {
    assert.equal(q.type, "choice");
    if (q.type !== "choice") throw new Error("choice expected");
    assert.deepEqual(Object.keys(q.criteria), ["__unmatched__", "____unmatched__"]);
    return answer({ __unmatched__: 0.9, ____unmatched__: 0.1 });
  });
  assert.equal(
    await Questions.create(provider)
      .about("x")
      .branch(
        "Route?",
        {
          __unmatched__: { description: "A legitimate application operation", run: () => "app" },
          ___unmatched__: { description: "Disabled", enabled: false, run: () => "disabled" },
        },
        { selection: { allowUnmatched: true } },
      ),
    "app",
  );
});

test("new routing uses the actual top probability even when the declared winner is within decoder tolerance", async () => {
  const q = Questions.create(
    fixture(() => answer({ review: 0.5, explain: 0.5000005 }, "review")),
  ).about("x");
  assert.equal(await q.branch("Route?", descriptors), "explain");
});

test("guidance, eligibility, thresholds and callbacks are captured before asynchronous context", async () => {
  const started = deferred<void>();
  const state = deferred<string>();
  const provider = fixture(() => answer({ review: 0.6, explain: 0.4 }));
  const branches = {
    review: {
      description: "Before",
      examples: ["Before example"],
      enabled: true,
      run: () => "before",
    },
    explain: { description: "Explain", enabled: true, run: () => "explain" },
  };
  const options: BranchOptions<string> = {
    selection: { minProbability: 0.8 },
    onUncertain: () => "original-fallback",
  };
  const promise = Questions.create(provider)
    .about(async () => {
      started.resolve();
      return state.promise;
    })
    .branch("Route?", branches, options);
  await started.promise;
  branches.review.description = "After";
  branches.review.examples[0] = "After example";
  branches.review.run = () => "after";
  branches.explain.enabled = false;
  Object.assign(options, {
    selection: { minProbability: 0.1 },
    onUncertain: () => "changed-fallback",
  });
  state.resolve("x");
  assert.equal(await promise, "original-fallback");
  const question = provider.calls[0]!.questions.answer;
  if (question?.type === "choice") {
    assert.deepEqual(question.criteria.review, {
      description: "Before",
      examples: ["Before example"],
    });
    assert.ok(Object.hasOwn(question.criteria, "explain"));
  }
});

test("invalid descriptor and routing options fail before context, even for disabled branches", async () => {
  const provider = fixture();
  const q = Questions.create(provider).about(() => {
    throw new Error("should not read context");
  });
  const badBranches: unknown[] = [
    { a: { description: "", run: () => 1 } },
    { a: { description: "A", run: 1 } },
    { a: { description: "A", run: () => 1, enabled: "false" } },
    { a: { description: "A", run: () => 1, enabled: false, examples: [1] } },
    { a: { description: "A", run: () => 1, examples: "example" } },
  ];
  for (const branches of badBranches)
    await assert.rejects(q.branch("Route?", branches as Branches), ValidationError);
  const badOptions: unknown[] = [
    { selection: { minProbability: -1 } },
    { selection: { minMargin: NaN } },
    { selection: { allowUnmatched: 1 } },
    { selection: { confidence: 1 } },
    { selection: null },
    { onUnmatched: true },
    { onUncertain: "fallback" },
  ];
  for (const options of badOptions)
    await assert.rejects(
      q.branch("Route?", descriptors, options as BranchOptions),
      ValidationError,
    );
  assert.equal(provider.calls.length, 0);
});

test("provider, context and malformed-evidence failures never invoke semantic fallbacks", async () => {
  let callbacks = 0;
  const options = { onUncertain: () => callbacks++, onUnmatched: () => callbacks++ };
  const expected = new Error("provider unavailable");
  const model: QuestionModel = {
    name: "failure",
    async evaluate() {
      throw expected;
    },
  };
  await assert.rejects(
    Questions.create({ model }).about("x").branch("Route?", descriptors, options),
    (error) => error === expected,
  );
  const provider = fixture(() => answer({ review: 0.9, missing: 0.1 }));
  await assert.rejects(
    Questions.create(provider).about("x").branch("Route?", descriptors, options),
    ValidationError,
  );
  await assert.rejects(
    Questions.create(provider)
      .about(() => {
        throw expected;
      })
      .branch("Route?", descriptors, options),
    (error) => error === expected,
  );
  assert.equal(callbacks, 0);
  assert.equal(provider.calls.length, 1);
});

test("existing confidence gates remain hard errors and are not routing uncertainty", async () => {
  let called = 0;
  const provider = fixture(() => answer({ review: 0.9, explain: 0.1 }, undefined, 0.3));
  await assert.rejects(
    Questions.create({ model: provider.model, defaults: { confidence: 0.8 } })
      .about("x")
      .branch("Route?", descriptors, {
        onUncertain: () => called++,
        onUnmatched: () => called++,
      }),
    UncertainDecision,
  );
  assert.equal(called, 0);
});

test("business and explicit fallback handler failures keep identity without retries or another handler", async () => {
  const error = new Error("business failure");
  let invoked = 0;
  const q = Questions.create(fixture(() => answer({ review: 1, explain: 0 }))).about("x");
  await assert.rejects(
    q.branch(
      "Route?",
      {
        review: {
          description: "Review",
          run: () => {
            invoked++;
            throw error;
          },
        },
        explain: {
          description: "Explain",
          run: () => {
            throw new Error("must not fall through");
          },
        },
      },
      {
        onUncertain: () => {
          throw new Error("not a catch");
        },
        onUnmatched: () => {
          throw new Error("not a catch");
        },
      },
    ),
    (failure) => failure === error,
  );
  assert.equal(invoked, 1);
  const ambiguous = Questions.create(fixture(() => answer({ review: 0.5, explain: 0.5 }))).about(
    "x",
  );
  await assert.rejects(
    ambiguous.branch("Route?", descriptors, {
      onUncertain: async () => {
        throw error;
      },
    }),
    (failure) => failure === error,
  );
});

test("routing and handlers share a deadline and cooperative AbortSignal", async () => {
  const started = deferred<AbortSignal>();
  const waiting = deferred<void>();
  let called = 0;
  const provider: QuestionModel = {
    name: "pending",
    async evaluate(_request, { signal } = {}) {
      started.resolve(signal!);
      await waiting.promise;
      throw new Error("late failure");
    },
  };
  const controller = new AbortController();
  const reason = new Error("stop");
  const result = Questions.create({ model: provider })
    .about("x")
    .branch("Route?", descriptors, {
      signal: controller.signal,
      onUncertain: () => called++,
      onUnmatched: () => called++,
    });
  const rejected = assert.rejects(result, (error) => error === reason);
  const signal = await started.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(signal.aborted, true);
  waiting.resolve();
  assert.equal(called, 0);
  let handlerSignal: AbortSignal | undefined;
  await assert.rejects(
    Questions.create(fixture())
      .about("x")
      .branch(
        "Route?",
        {
          a: {
            description: "A",
            run: ({ signal }) => {
              handlerSignal = signal;
              return new Promise<void>(() => {});
            },
          },
          b: { description: "B", run: () => "b" },
        },
        { timeout: "30 ms" },
      ),
    TimeoutError,
  );
  assert.equal(handlerSignal?.aborted, true);
});

test("semantic hooks run once, before the selected handler, and can cancel it", async () => {
  const events: DecisionEvent[] = [];
  const order: string[] = [];
  const provider = fixture();
  const q = Questions.create({
    model: provider.model,
    hooks: {
      onEvaluate: () => {
        order.push("evaluate");
      },
      onDecision: (event) => {
        events.push(event);
        order.push("decision");
      },
    },
  }).about("private intent");
  assert.equal(
    await q.branch("Route?", {
      a: {
        description: "Private rule",
        run: () => {
          order.push("handler");
          return "PRIVATE-RESULT";
        },
      },
      b: descriptors.explain,
    }),
    "PRIVATE-RESULT",
  );
  assert.deepEqual(order, ["evaluate", "decision", "handler"]);
  assert.equal(events[0]!.operation, "branch");
  assert.equal(events[0]!.evaluationCount, 1);
  assert.equal(events[0]!.questionCount, 1);
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
  const abort = new AbortController();
  let ran = false;
  const error = new Error("cancel before handler");
  await assert.rejects(
    q.branch(
      "Route?",
      {
        a: () => {
          ran = true;
        },
        b: () => undefined,
      },
      {
        signal: abort.signal,
        hooks: { onDecision: () => abort.abort(error) },
      },
    ),
    (failure) => failure === error,
  );
  assert.equal(ran, false);
});

test("route uncertainty is classified as semantic uncertainty without exposing evidence to hooks", async () => {
  const errors: OperationErrorEvent[] = [];
  const provider = fixture(() => answer({ review: 0.5, explain: 0.5 }));
  const q = Questions.create({
    model: provider.model,
    hooks: {
      onError: (error) => {
        errors.push(error);
      },
    },
  }).about("private intent");
  await assert.rejects(q.branch("Route?", descriptors), UncertainBranchError);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.kind, "uncertain");
  assert.equal(errors[0]!.stage, "decision");
  assert.ok(!JSON.stringify(errors).includes("ranked"));
  assert.ok(!JSON.stringify(errors).includes("private intent"));
});

test("a policy called from a branch is a distinct evaluation, while direct invocation skips routing", async () => {
  const provider = fixture();
  const client = Questions.create(provider);
  const policy = Policy.from(
    { ready: Question.boolean("Ready?") },
    { thresholds: { accept: 0.8, reject: 0.2 } },
  )
    .when(({ ready }) => ready.is(true), "ship")
    .otherwise("wait");
  assert.equal(await client.about("change").decide(policy), "ship");
  assert.equal(provider.calls.length, 1);
  assert.equal(
    await client.about("Review please").branch("Route?", {
      review: {
        description: "Review",
        run: ({ signal }) => client.about("change").decide(policy, { signal }),
      },
      explain: descriptors.explain,
    }),
    "ship",
  );
  assert.equal(provider.calls.length, 3);
});
