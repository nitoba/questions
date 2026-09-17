import { test } from "bun:test";
import assert from "node:assert/strict";
import { Questions, TypeSafe, Question, ValidationError } from "../src/index.ts";
import { decode } from "../src/internal/decode.ts";

test("native System One probabilities identify the protocol, not a calibration guarantee", async () => {
  const client = Questions.create({
    model: TypeSafe.create({
      apiKey: "test-only",
      fetch: (async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          model: "jev-test",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: {
            flag: { type: "noul", noul: 0.8 },
            route: {
              type: "choice",
              choice: "a",
              confidence: 0.6,
              probabilities: { a: 0.8, b: 0.2 },
            },
          },
        })) as typeof fetch,
    }),
  });
  const result = await client
    .about("x")
    .evidence({ flag: "OK?", route: Question.choice("Route?", { a: "A", b: "B" }) });
  assert.equal(result.answers.flag.probabilitySource, "provider");
  assert.equal(result.answers.route.probabilitySource, "provider");
});

test("legacy evidence keeps unknown provenance; invalid provenance fails for every answer type", () => {
  const questions = {
    ok: Question.boolean("OK?"),
    route: Question.choice("Route?", { a: "A", b: "B" }),
    score: Question.score("Score?", ["Low", "High"]),
  };
  const raw = {
    model: "custom",
    usage: {},
    answers: {
      ok: { type: "boolean", probability: 0.8 },
      route: { type: "choice", choice: "a", confidence: 0.6, probabilities: { a: 0.8, b: 0.2 } },
      score: {
        type: "score",
        score: 0.8,
        confidence: 0.6,
        probabilities: { "0": 0.2, "1": 0.8 },
        legend: { "0": "Low", "1": "High" },
      },
    },
  };
  for (const answer of Object.values(decode(raw, questions).answers))
    assert.equal(answer.probabilitySource, undefined);
  for (const id of Object.keys(raw.answers) as (keyof typeof raw.answers)[]) {
    assert.throws(
      () =>
        decode(
          {
            ...raw,
            answers: {
              ...raw.answers,
              [id]: { ...raw.answers[id], probabilitySource: "calibrated" },
            },
          },
          questions,
        ),
      ValidationError,
    );
  }
});
