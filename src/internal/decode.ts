import type { AnyAnswer } from "../answer.ts";
import type { AnyQuestion, Batch } from "../question.ts";
import type { Evaluation } from "../model.ts";
import { ValidationError } from "../errors.ts";
import { exactKeys, finite, integer, probability, record, text } from "./validation.ts";

// Accept ordinary floating-point rounding, never silently normalize malformed evidence.
export const TOLERANCE = 1e-6;

export function distribution(value: unknown, keys: readonly string[], path: string): Readonly<Record<string, number>> {
  const object = record(value, path);
  exactKeys(object, keys, path);
  const result = Object.fromEntries(keys.map((key) => [key, probability(object[key], `${path}.${key}`)]));
  const total = Object.values(result).reduce((sum, mass) => sum + mass, 0);
  if (Math.abs(total - 1) > TOLERANCE) throw new ValidationError("probabilities must sum to 1", path);
  return Object.freeze(result);
}

function decodeAnswer(value: unknown, question: AnyQuestion, path: string): AnyAnswer {
  const answer = record(value, path);
  if (answer.type !== question.type) throw new ValidationError("answer type differs from question", `${path}.type`);
  if (question.type === "boolean") {
    return Object.freeze({ type: "boolean", probability: probability(answer.probability, `${path}.probability`) });
  }
  const confidence = probability(answer.confidence, `${path}.confidence`);
  const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const probabilities = distribution(answer.probabilities, keys, `${path}.probabilities`);
  if (question.type === "choice") {
    if (typeof answer.choice !== "string" || !Object.hasOwn(probabilities, answer.choice)) {
      throw new ValidationError("selected option is not declared", `${path}.choice`);
    }
    const winner = probabilities[answer.choice]!;
    if (Object.values(probabilities).some((mass) => mass > winner + TOLERANCE)) {
      throw new ValidationError("selected option is not a maximum-probability outcome", `${path}.choice`);
    }
    return Object.freeze({ type: "choice", choice: answer.choice, probabilities, confidence });
  }
  const score = finite(answer.score, `${path}.score`);
  const expected = keys.reduce((sum, key) => sum + Number(key) * probabilities[key]!, 0);
  if (score < 0 || score > keys.length - 1 || Math.abs(score - expected) > TOLERANCE * keys.length) {
    throw new ValidationError("score differs from its probability-weighted level index", `${path}.score`);
  }
  const legend = record(answer.legend, `${path}.legend`);
  exactKeys(legend, keys, `${path}.legend`);
  for (const key of keys) {
    if (legend[key] !== question.criteria[Number(key)]) {
      throw new ValidationError("legend differs from the requested rubric", `${path}.legend.${key}`);
    }
  }
  return Object.freeze({ type: "score", score, probabilities, confidence,
    legend: Object.freeze(Object.fromEntries(keys.map((key) => [key, legend[key] as string]))),
  });
}

export function decode<B extends Batch>(value: unknown, questions: Readonly<Record<string, AnyQuestion>>): Evaluation<B> {
  const response = record(value, "response");
  const answers = record(response.answers, "response.answers");
  const usage = record(response.usage, "response.usage");
  exactKeys(answers, Object.keys(questions), "response.answers");
  // The runtime key-by-key checks above restore the correlation erased by Object.entries.
  return Object.freeze({
    model: text(response.model, "response.model"),
    usage: Object.freeze({
      inputTokens: integer(usage.inputTokens, 0, "response.usage.inputTokens"),
      outputTokens: integer(usage.outputTokens, 0, "response.usage.outputTokens"),
    }),
    answers: Object.freeze(Object.fromEntries(Object.entries(questions).map(([key, question]) => [
      key, decodeAnswer(answers[key], question, `response.answers.${key}`),
    ]))),
  }) as Evaluation<B>;
}
