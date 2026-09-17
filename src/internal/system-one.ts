import type { EvaluationRequest } from "../model.ts";
import type { Description } from "../types.ts";
import { ValidationError } from "../errors.ts";
import { normalize } from "../question.ts";
import { record, state as validateState } from "./validation.ts";

function describe(value: Description): string | null {
  return value === null || typeof value === "string" ? value : JSON.stringify(value);
}

export function requestBody(
  request: EvaluationRequest,
  model: string,
  maxCriteria: number,
): string {
  const questions = normalize(request.questions);
  const wire = Object.fromEntries(
    Object.entries(questions).map(([key, question]) => {
      if (question.type !== "boolean" && Object.keys(question.criteria).length > maxCriteria) {
        throw new ValidationError(
          `provider supports at most ${maxCriteria} criteria`,
          `questions.${key}.criteria`,
        );
      }
      switch (question.type) {
        case "boolean":
          return [
            key,
            {
              type: "noul",
              instructions: question.instructions,
              ...(question.criteria === undefined
                ? {}
                : {
                    criteria: {
                      true: describe(question.criteria.true),
                      false: describe(question.criteria.false),
                    },
                  }),
            },
          ];
        case "choice":
          return [
            key,
            {
              ...question,
              criteria: Object.fromEntries(
                Object.entries(question.criteria).map(([id, value]) => [id, describe(value)]),
              ),
            },
          ];
        case "score":
          return [key, question];
      }
    }),
  );
  return JSON.stringify({ state: validateState(request.state), model, questions: wire });
}

/** Convert only the provider protocol. The Questions client performs full semantic validation. */
export function normalizeResponse(value: unknown): unknown {
  const response = record(value, "response");
  const usage = record(response.usage, "response.usage");
  const answers = record(response.answers, "response.answers");
  return {
    model: response.model,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, raw]) => {
        const answer = record(raw, `response.answers.${key}`);
        return [
          key,
          answer.type === "noul"
            ? { type: "boolean", probability: answer.noul, probabilitySource: "provider" }
            : { ...answer, confidenceSource: "provider", probabilitySource: "provider" },
        ];
      }),
    ),
  };
}
