import type { EvaluationRequest, QuestionModel } from "../src/model.ts";
import type { AnyQuestion } from "../src/question.ts";

/** Deterministic, provider-neutral fixture. Never used by production code or live examples. */
export function fixture(answer?: (question: AnyQuestion, key: string, request: EvaluationRequest) => unknown) {
  const calls: EvaluationRequest[] = [];
  const model: QuestionModel = {
    name: "fixture",
    async evaluate(request) {
      calls.push(request);
      return {
        model: "fixture-v1", usage: { inputTokens: 12, outputTokens: 3 },
        answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [
          key, answer ? answer(question, key, request) : evidence(question),
        ])),
      };
    },
  };
  return { model, calls };
}

export function evidence(question: AnyQuestion): unknown {
  if (question.type === "boolean") return { type: "boolean", probability: 0.9 };
  const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const probabilities = Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0]));
  if (question.type === "choice") return { type: "choice", choice: keys[0], probabilities, confidence: 1 };
  return { type: "score", score: 0, probabilities, confidence: 1,
    legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
  };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
