import type { Description } from "./types.ts";
import { ValidationError } from "./errors.ts";
import { record, state, text } from "./internal/validation.ts";

/** A provider-neutral yes/no question. */
export interface BooleanQuestion {
  readonly type: "boolean";
  readonly instructions: string;
  readonly criteria?: { readonly true: Description; readonly false: Description };
}
/** A closed choice whose answer is one of the literal option keys. */
export interface ChoiceQuestion<K extends string = string> {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<K, Description>>;
}
/** A zero-based, probability-weighted ordinal rubric. */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly [string, string, ...string[]];
}
/** The finite question algebra understood by providers. */
export type AnyQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;
/** Strings are shorthand for boolean questions. Keys are preserved in all results. */
export type Batch = Readonly<Record<string, string | AnyQuestion>>;
/** Infer the plain value of a question. */
export type Value<Q> = Q extends string | BooleanQuestion
  ? boolean
  : Q extends ChoiceQuestion<infer K>
    ? K
    : Q extends ScoreQuestion
      ? number
      : never;
/** Infer every named result in a batch without widening choice literals. */
export type Values<B extends Batch> = { readonly [K in keyof B]: Value<B[K]> };

function description(value: unknown, path: string): Description {
  return value === null ? null : state(value, path);
}

/**
 * Declare a yes/no question without performing inference.
 * @example
 * const blocked = Question.boolean("Is production blocked?", {
 *   true: "No production work can continue", false: "Work remains possible",
 * });
 */
export function boolean(
  instructions: string,
  criteria?: BooleanQuestion["criteria"],
): BooleanQuestion {
  text(instructions, "instructions");
  if (criteria === undefined) return Object.freeze({ type: "boolean", instructions });
  record(criteria, "criteria");
  return Object.freeze({
    type: "boolean",
    instructions,
    criteria: Object.freeze({
      true: description(criteria.true, "criteria.true"),
      false: description(criteria.false, "criteria.false"),
    }),
  });
}

/**
 * Declare a choice. At least two options are required; option keys remain literal types.
 * Inputs are snapshotted so later mutations cannot change the question.
 * @example
 * const team = Question.choice("Which team?", { billing: "Charges", support: "Bugs" });
 */
export function choice<const C extends Readonly<Record<string, Description>>>(
  instructions: string,
  criteria: C,
): ChoiceQuestion<keyof C & string> {
  text(instructions, "instructions");
  const entries = Object.entries(record(criteria, "criteria"));
  if (entries.length < 2)
    throw new ValidationError("at least two options are required", "criteria");
  const snapshot = Object.freeze(
    Object.fromEntries(entries.map(([key, value]) => [key, description(value, `criteria.${key}`)])),
  ) as Readonly<Record<keyof C & string, Description>>;
  return Object.freeze({ type: "choice", instructions, criteria: snapshot });
}

/**
 * Declare ordered levels. A three-level rubric yields a score in [0, 2], not [0, 1].
 * @example
 * const urgency = Question.score("How urgent?", ["Low", "Medium", "High"]);
 */
export function score(
  instructions: string,
  levels: readonly [string, string, ...string[]],
): ScoreQuestion {
  text(instructions, "instructions");
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new ValidationError("at least two levels are required", "criteria");
  }
  const criteria = Object.freeze(
    levels.map((level, index) => text(level, `criteria.${index}`)),
  ) as unknown as ScoreQuestion["criteria"];
  return Object.freeze({ type: "score", instructions, criteria });
}

/** @internal Normalize and snapshot question definitions before provider invocation. */
export function normalize(batch: Batch): Readonly<Record<string, AnyQuestion>> {
  const entries = Object.entries(record(batch, "questions"));
  if (entries.length === 0)
    throw new ValidationError("at least one question is required", "questions");
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, input]) => {
        if (typeof input === "string") return [key, boolean(input)];
        const defined = record(input, `questions.${key}`) as unknown as AnyQuestion;
        switch (defined.type) {
          case "boolean":
            return [key, boolean(defined.instructions, defined.criteria)];
          case "choice":
            return [key, choice(defined.instructions, defined.criteria)];
          case "score":
            return [key, score(defined.instructions, defined.criteria)];
          default:
            throw new ValidationError("unknown question type", `questions.${key}.type`);
        }
      }),
    ),
  );
}
