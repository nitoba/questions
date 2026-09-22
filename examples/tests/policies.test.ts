import { test } from "bun:test";
import assert from "node:assert/strict";
import { Questions } from "../../src/index.ts";
import { fixture, evidence } from "../../tests/helpers.ts";
import { main, answerChange, changes, zodReview } from "../18-policies-and-routing.ts";

function routing(choice: string, keys: readonly string[]) {
  return {
    type: "choice",
    choice,
    confidence: 1,
    probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
  };
}

test("lesson 18 executes direct, streamed and summary-routed work without hidden evaluation", async () => {
  const provider = fixture((question) => {
    if (question.type === "choice" && Object.hasOwn(question.criteria, "explain"))
      return routing("explain", Object.keys(question.criteria));
    return evidence(question);
  });
  const result = await main(Questions.create(provider));
  assert.equal(result.direct, "ship");
  assert.equal(result.trace.selected.kind, "otherwise");
  assert.deepEqual(result.batch, ["ship", "ship"]);
  assert.equal(result.routed, changes[0]!.summary);
  assert.equal(provider.calls.length, 4);
  assert.equal(provider.calls[3]!.state, "Show the existing summary.");
  assert.deepEqual(Object.keys(provider.calls[0]!.questions), ["impact", "regression"]);
});

test("lesson 18 uses the full change only inside the selected review handler", async () => {
  const provider = fixture((question) => {
    if (question.type === "choice" && Object.hasOwn(question.criteria, "review"))
      return routing("review", Object.keys(question.criteria));
    if (question.type === "choice") return routing("breaking", Object.keys(question.criteria));
    return { type: "boolean", probability: 0.62 };
  });
  const result = await answerChange(Questions.create(provider), {
    ask: "Is it safe?",
    change: changes[0]!,
  });
  assert.equal(result, "human-review");
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]!.state, "Is it safe?");
  assert.deepEqual(provider.calls[1]!.state, changes[0]);
});

test("lesson 18 Zod policy executes through the same client and decision executor", async () => {
  const provider = fixture();
  const result = await Questions.create(provider).about(changes[0]!).decide(zodReview);
  assert.equal(result, "ship");
  assert.equal(provider.calls.length, 1);
});
