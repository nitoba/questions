import type { EvaluationRequest, Rounding } from "../model.ts";
import type { Description } from "../types.ts";
import { ValidationError } from "../errors.ts";
import { normalize } from "../question.ts";
import { record, state as validateState } from "./validation.ts";
import { TOLERANCE } from "./decode.ts";

/** Jev rounds probabilities and scores independently to two decimals without reporting it. */
export const JEV_ROUNDING: Rounding = Object.freeze({ probabilityDecimals: 2, scoreDecimals: 2 });

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

export type InconsistentChoice = "reject" | "argmax";

export interface Normalization {
  readonly rounding?: Rounding | undefined;
  readonly inconsistentChoice?: InconsistentChoice | undefined;
}

/**
 * The maximum-probability option when a well-formed choice is strictly beaten, otherwise undefined.
 * Malformed answers are left untouched so the client rejects them with their original path.
 */
function argmax(answer: Readonly<Record<string, unknown>>): string | undefined {
  const probabilities = answer.probabilities;
  if (typeof probabilities !== "object" || probabilities === null || Array.isArray(probabilities))
    return undefined;
  const entries = Object.entries(probabilities);
  if (!entries.every(([, mass]) => typeof mass === "number" && Number.isFinite(mass)))
    return undefined;
  const choice = answer.choice;
  if (typeof choice !== "string" || !Object.hasOwn(probabilities, choice)) return undefined;
  const [best, mass] = (entries as [string, number][]).reduce((a, b) => (b[1] > a[1] ? b : a));
  return mass > (probabilities as Record<string, number>)[choice]! + TOLERANCE ? best : undefined;
}

/**
 * Convert only the provider protocol. The Questions client performs full semantic validation.
 * Reported rounding wins; the configured declaration covers endpoints that round silently.
 * Opt-in argmax correction is reported as a compatibility warning, never applied silently.
 */
export function normalizeResponse(value: unknown, options: Normalization = {}): unknown {
  const { rounding, inconsistentChoice = "reject" } = options;
  const response = record(value, "response");
  const usage = record(response.usage, "response.usage");
  const answers = record(response.answers, "response.answers");
  const corrected: string[] = [];
  const normalized = Object.fromEntries(
    Object.entries(answers).map(([key, raw]) => {
      const answer = record(raw, `response.answers.${key}`);
      if (answer.type === "noul")
        return [key, { type: "boolean", probability: answer.noul, probabilitySource: "provider" }];
      const best =
        answer.type === "choice" && inconsistentChoice === "argmax" ? argmax(answer) : undefined;
      if (best !== undefined) corrected.push(key);
      return [
        key,
        {
          ...answer,
          ...(best === undefined ? {} : { choice: best }),
          confidenceSource: "provider",
          probabilitySource: "provider",
        },
      ];
    }),
  );
  return {
    model: response.model,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    ...(response.rounding === undefined && rounding === undefined
      ? {}
      : { rounding: response.rounding ?? rounding }),
    ...(corrected.length === 0
      ? {}
      : {
          warnings: [
            {
              type: "compatibility",
              feature: "choice",
              details: `replaced a choice that was not the maximum-probability option: ${corrected.join(", ")}`,
            },
          ],
        }),
    answers: normalized,
  };
}
