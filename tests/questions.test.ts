import { test } from "bun:test";
import assert from "node:assert/strict";
import { Questions, Question, ValidationError, UncertainDecision } from "../src/index.ts";
import { fixture } from "./helpers.ts";
import type { State } from "../src/types.ts";

const batch = {
  blocked: "Is production blocked?",
  team: Question.choice("Who owns it?", { billing: "Payments", support: "Bugs" }),
  urgency: Question.score("How urgent?", ["Low", "Medium", "High"]),
};

test("construction is pure; a mixed batch uses exactly one evaluation", async () => {
  const { model, calls } = fixture();
  const q = Questions.create({ model }).about("A ticket");
  assert.equal(calls.length, 0);
  assert.deepEqual(await q.ask(batch), { blocked: true, team: "billing", urgency: 0 });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0]!.questions).length, 3);
});

test("evidence retains usage, model and distributions", async () => {
  const result = await Questions.create(fixture()).about("context").evidence(batch);
  assert.equal(result.model, "fixture-v1");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(result.answers.team.probabilities.billing, 1);
  assert.ok(Object.isFrozen(result.answers.team.probabilities));
});

test("live context is evaluated anew; previous promises are not replayed", async () => {
  const { model, calls } = fixture();
  let revision = 1;
  const q = Questions.create({ model }).about(() => ({ revision }));
  const first = q.is("Ready?");
  await first;
  revision = 2;
  await first;
  await q.is("Ready?");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.state),
    [{ revision: 1 }, { revision: 2 }],
  );
});

test("confidence gates are explicit; rejected decisions retain evidence", async () => {
  const q = Questions.create(fixture(() => ({ type: "boolean", probability: 0.55 }))).about("x");
  await assert.rejects(q.is("Ready?", { confidence: 0.8 }), (error: unknown) => {
    assert.ok(error instanceof UncertainDecision);
    assert.equal(error.minimum, 0.8);
    assert.equal(error.question, "Ready?");
    assert.deepEqual(error.evidence, { type: "boolean", probability: 0.55 });
    return true;
  });
  assert.equal(await q.is("Ready?"), true);
  assert.equal(await q.probability("Ready?"), 0.55);
});

test("invalid thresholds fail before the provider is invoked", async () => {
  const { model, calls } = fixture();
  const q = Questions.create({ model }).about("x");
  for (const confidence of [NaN, Infinity, -1, 1.1]) {
    await assert.rejects(q.is("Ready?", { confidence }), ValidationError);
  }
  assert.equal(calls.length, 0);
});

test("choose preserves identity and only sends descriptions", async () => {
  const first = { id: 1, secret: "never send me", title: "Billing" };
  const second = { id: 2, secret: "private", title: "Support" };
  const { model, calls } = fixture();
  const q = Questions.create({ model }).about("x");
  assert.equal(await q.choose("Which?", [first, second], (item) => item.title), first);
  const ranked = await q.rank("Which?", { a: first, b: second }, (item) => item.title);
  assert.equal(ranked[0]!.value, first);
  assert.equal(ranked.length, 2);
  assert.ok(!JSON.stringify(calls).includes("never send me"));
});

test("branch runs only the selected handler and preserves sync/async return values", async () => {
  const q = Questions.create(fixture()).about("x");
  let first = 0;
  let second = 0;
  const result = await q.branch("Route?", {
    billing: () => {
      first++;
      return { invoice: 1 };
    },
    support: async () => {
      second++;
      return { case: 2 };
    },
  });
  assert.deepEqual(result, { invoice: 1 });
  assert.equal(first, 1);
  assert.equal(second, 0);
});

test("uncertain branches run no handlers and handler errors are not replaced", async () => {
  let invoked = 0;
  const uncertain = Questions.create(
    fixture(() => ({
      type: "choice",
      choice: "a",
      probabilities: { a: 0.5, b: 0.5 },
      confidence: 0,
    })),
  ).about("x");
  await assert.rejects(
    uncertain.branch("Which?", { a: () => invoked++, b: () => invoked++ }, { confidence: 0.5 }),
    UncertainDecision,
  );
  assert.equal(invoked, 0);
  const failure = new Error("handler failure");
  await assert.rejects(
    Questions.create(fixture())
      .about("x")
      .branch("Which?", {
        a: () => {
          throw failure;
        },
        b: () => 0,
      }),
    (error) => error === failure,
  );
});

test("each batches all items and safely regroups arbitrary user keys", async () => {
  const { model, calls } = fixture();
  const rows = await Questions.create({ model })
    .each(["a", "b"])
    .ask({ "item1.answer": "Relevant?", "": "Done?" });
  assert.deepEqual(rows, [
    { "item1.answer": true, "": true },
    { "item1.answer": true, "": true },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0]!.questions).length, 4);
  assert.ok(calls[0]!.questions.i0q0!.instructions.includes("About item0:"));
});

test("empty collections make no requests; empty questions are still rejected", async () => {
  const { model, calls } = fixture();
  const each = Questions.create({ model }).each([]);
  assert.deepEqual(await each.is("Ready?"), []);
  await assert.rejects(each.ask({}), ValidationError);
  assert.equal(calls.length, 0);
});

test("pre-aborted operations do not read live context or call the provider", async () => {
  const { model, calls } = fixture();
  let reads = 0;
  const stop = new Error("stop");
  const q = Questions.create({ model }).about(() => {
    reads++;
    return "context";
  });
  await assert.rejects(
    q.is("Ready?", { signal: AbortSignal.abort(stop) }),
    (error) => error === stop,
  );
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
});

test("cancellation settles a non-cooperative provider and preserves the reason", async () => {
  const controller = new AbortController();
  const stop = new Error("stop");
  const q = Questions.create({
    model: { name: "slow", evaluate: () => new Promise(() => {}) },
  }).about("x");
  const pending = q.is("Ready?", { signal: controller.signal });
  controller.abort(stop);
  await assert.rejects(pending, (error) => error === stop);
});

test("question definitions snapshot inputs and handle prototype-like keys safely", async () => {
  const options = { billing: { title: "Billing" }, support: "Support" };
  const question = Question.choice("Which?", options);
  options.billing.title = "changed";
  assert.deepEqual(question.criteria.billing, { title: "Billing" });
  const unusual = Object.fromEntries([
    ["__proto__", "Safe?"],
    ["constructor", "Ready?"],
  ]);
  const values = await Questions.create(fixture()).about("x").ask(unusual);
  assert.equal(Object.getPrototypeOf(values), Object.prototype);
  assert.equal(values.__proto__, true);
  assert.equal(values.constructor, true);
});

test("invalid contexts fail before inference without silent JSON loss", async () => {
  const { model, calls } = fixture();
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  // Deliberately construct holes without hiding an accidental sparse literal from lint.
  const intentionallySparseContext: unknown[] = [];
  intentionallySparseContext.length = 2;
  for (const context of [
    undefined,
    NaN,
    new Date(),
    { bad: undefined },
    { bad: 1n },
    cyclic,
    intentionallySparseContext,
  ]) {
    await assert.rejects(
      Questions.create({ model })
        .about(context as State)
        .is("Ready?"),
      ValidationError,
    );
  }
  assert.equal(calls.length, 0);
});

test("invalid definition cardinalities and missing criteria fail synchronously", () => {
  assert.throws(() => Question.choice("Which?", { a: "A" }), ValidationError);
  assert.throws(() => Question.boolean("  "), ValidationError);
  assert.throws(
    () => Question.score("How?", [] as unknown as readonly [string, string]),
    ValidationError,
  );
  assert.throws(() => Question.boolean("Ready?", null as never), ValidationError);
});
