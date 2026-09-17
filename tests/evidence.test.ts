import { test } from "bun:test";
import assert from "node:assert/strict";
import { Answer, Decision, Question, Questions, UncertainDecision, ValidationError } from "../src/index.ts";
import { fixture } from "./helpers.ts";

const chosen = { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 };
const route = Question.choice("Route?", { a: "A", b: "B" });
const score = { type: "score", score: 1.6, probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
  confidence: 0.35, legend: { "0": "Low", "1": "Medium", "2": "High" } };

test("choice validation rejects missing, extra, invalid or inconsistent evidence", async () => {
  const malformed = [
    { ...chosen, probabilities: { a: 0.8 } },
    { ...chosen, probabilities: { a: 0.8, b: 0.1, c: 0.1 } },
    { ...chosen, probabilities: { a: 0.8, b: 0.3 } },
    { ...chosen, probabilities: { a: NaN, b: 0.2 } },
    { ...chosen, probabilities: { a: -0.1, b: 1.1 } },
    { ...chosen, choice: "b" }, { ...chosen, choice: "constructor" },
    { ...chosen, confidence: 2 }, { ...chosen, type: "boolean" },
  ];
  for (const answer of malformed) {
    const { model } = fixture(() => answer);
    await assert.rejects(Questions.create({ model }).about("x").ask({ route }), ValidationError);
  }
});

test("score validation checks weighted value and exact rubric without normalizing", async () => {
  const rubric = Question.score("Urgency?", ["Low", "Medium", "High"]);
  const { model } = fixture(() => score);
  assert.equal((await Questions.create({ model }).about("x").ask({ rubric })).rubric, 1.6);
  for (const answer of [
    { ...score, score: 0.6 }, { ...score, score: 3 }, { ...score, score: Infinity },
    { ...score, legend: { "0": "Low", "1": "Medium", "2": "Critical" } },
    { ...score, probabilities: { "0": 0.05, "1": 0.3, "2": 0.6 } },
  ]) {
    const bad = fixture(() => answer);
    await assert.rejects(Questions.create({ model: bad.model }).about("x").ask({ rubric }), ValidationError);
  }
});

test("provider response envelope validates usage and exact batch keys", async () => {
  const valid = { model: "fixture", usage: { inputTokens: 0, outputTokens: 1 },
    answers: { ok: { type: "boolean", probability: 0.5 } } };
  for (const result of [
    { ...valid, model: "" }, { ...valid, usage: { inputTokens: -1, outputTokens: 1 } },
    { ...valid, usage: { inputTokens: 0.1, outputTokens: 1 } },
    { ...valid, answers: {} }, { ...valid, answers: { ...valid.answers, extra: valid.answers.ok } },
    { ...valid, answers: { ok: { type: "boolean", probability: Infinity } } },
  ]) {
    const model = { name: "bad", async evaluate() { return result; } };
    await assert.rejects(Questions.create({ model }).about("x").ask({ ok: "OK?" }), ValidationError);
  }
});

test("floating-point tolerance accepts small rounding without changing probabilities", async () => {
  const answer = { ...chosen, probabilities: { a: 0.7999999, b: 0.2 } };
  const { model } = fixture(() => answer);
  const evidence = await Questions.create({ model }).about("x").evidence({ route });
  assert.equal(evidence.answers.route.probabilities.a, 0.7999999);
});

test("boolean tie favors true, but confidence gating rejects ambiguous decisions", async () => {
  const { model } = fixture(() => ({ type: "boolean", probability: 0.5 }));
  const q = Questions.create({ model }).about("x");
  assert.equal(await q.is("OK?"), true);
  await assert.rejects(q.is("OK?", { confidence: 0.1 }), UncertainDecision);
});

test("pure probability helpers rank, aggregate and compute expected values", () => {
  const evidence = { probabilities: { invoice: 0.35, refund: 0.35, bug: 0.3 } };
  assert.deepEqual(Answer.topK(evidence, 2).map((x) => x.value), ["invoice", "refund"]);
  assert.equal(Answer.margin(evidence), 0);
  assert.equal(Answer.probabilityOf(evidence, (key) => key !== "bug"), 0.7);
  assert.deepEqual(Answer.coarsen(evidence, (key) => key === "bug" ? "support" : "billing"),
    { probabilities: { billing: 0.7, support: 0.3 } });
  assert.equal(Answer.expectedValue(evidence, () => 10), 10);
  assert.deepEqual(Answer.fromBoolean({ type: "boolean", probability: 0.25 }), { probabilities: { true: 0.25, false: 0.75 } });
  assert.equal(Answer.margin({ probabilities: {} }), 0);
});

test("aggregation preserves prototype-like names as own keys", () => {
  const result = Answer.coarsen({ probabilities: { a: 0.4, b: 0.6 } }, () => "__proto__");
  assert.equal(Object.hasOwn(result.probabilities, "__proto__"), true);
  assert.equal(result.probabilities.__proto__, 1);
});

test("expected loss supports tables, functions and constant actions", () => {
  const evidence = { probabilities: { safe: 0.95, unsafe: 0.05 } };
  const decision = Decision.minimizeLoss(evidence, {
    approve: { safe: 0, unsafe: 100 }, review: 2, reward: (outcome) => outcome === "safe" ? -1 : 100,
  });
  assert.equal(decision.choice, "review");
  assert.equal(decision.expectedLoss, 2);
  assert.equal(decision.alternatives.length, 3);
  const ran: string[] = [];
  assert.equal(Decision.match(decision, { approve: () => 0, review: () => { ran.push("review"); return 2; }, reward: () => 1 }), 2);
  assert.deepEqual(ran, ["review"]);
});

test("loss validation rejects incomplete costs even for zero-mass outcomes", () => {
  const evidence = { probabilities: { a: 1, b: 0 } };
  assert.throws(() => Decision.risks(evidence, { act: { a: 0 } } as unknown as { act: Record<"a" | "b", number> }), ValidationError);
  assert.throws(() => Decision.risks(evidence, { act: { a: 0, b: Infinity } }), ValidationError);
  assert.throws(() => Decision.risks(evidence, {}), ValidationError);
  assert.throws(() => Decision.risks({ probabilities: { a: 0 } }, { act: 0 }), ValidationError);
  assert.throws(() => Answer.expectedValue(evidence, () => NaN), ValidationError);
});

test("confidence preserves evidence identity and minimum-risk ties are stable", () => {
  const answer = { type: "boolean", probability: 0.95 } as const;
  assert.equal(Decision.requireConfidence(answer, 0.8), answer);
  assert.equal(Decision.minimizeLoss({ probabilities: { a: 1 } }, { first: 1, second: 1 }).choice, "first");
  assert.throws(() => Decision.requireConfidence(answer, NaN), ValidationError);
});
