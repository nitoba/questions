import type { Batch, BooleanQuestion, ChoiceQuestion, ScoreQuestion } from "./question.ts";
import { finite, integer, probability } from "./internal/validation.ts";

/** How probabilities were obtained, independently of the confidence calculation.
 * `provider` means supplied by an evaluation protocol, not calibrated correctness.
 * `estimated` means elicited from generated text. Missing provenance is unknown.
 */
export type ProbabilitySource = "provider" | "estimated" | "custom";

/** The probability that a yes/no proposition is true. */
export interface BooleanAnswer {
  readonly type: "boolean";
  readonly probabilitySource?: ProbabilitySource;
  readonly probability: number;
}
/** Origin of choice/score confidence. Undefined on older custom providers. */
export type ConfidenceSource = "provider" | "margin" | "custom";
/** A selected option and complete distribution; inspect confidenceSource before comparing providers. */
export interface ChoiceAnswer<K extends string = string> {
  readonly type: "choice";
  readonly probabilitySource?: ProbabilitySource;
  readonly choice: K;
  readonly probabilities: Readonly<Record<K, number>>;
  readonly confidence: number;
  /** The metric used for confidence, not a calibration or accuracy guarantee. */
  readonly confidenceSource?: ConfidenceSource;
}
/** A weighted level index, with the original rubric and complete distribution. */
export interface ScoreAnswer {
  readonly type: "score";
  readonly probabilitySource?: ProbabilitySource;
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly legend: Readonly<Record<string, string>>;
  readonly confidence: number;
  /** The metric used for confidence, not a calibration or accuracy guarantee. */
  readonly confidenceSource?: ConfidenceSource;
}
/** The normalized evidence algebra. */
export type AnyAnswer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;
/** Infer the evidence belonging to a particular question. */
export type Evidence<Q> = Q extends string | BooleanQuestion
  ? BooleanAnswer
  : Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;
/** Preserve the correlation between each question key and its evidence. */
export type Answers<B extends Batch> = { readonly [K in keyof B]: Evidence<B[K]> };
/** Sparse probability mass. Pure helpers do not renormalize or assume independence. */
export interface Distribution<K extends string = string> {
  readonly probabilitySource?: ProbabilitySource;
  readonly probabilities: Readonly<Partial<Record<K, number>>>;
}
/** An outcome or application value paired with its probability. */
export interface Ranked<T> {
  readonly value: T;
  readonly probability: number;
}

function entries<K extends string>(answer: Distribution<K>): Ranked<K>[] {
  return (Object.keys(answer.probabilities) as K[]).flatMap((value) => {
    const mass = answer.probabilities[value];
    return mass === undefined
      ? []
      : [{ value, probability: probability(mass, `probabilities.${value}`) }];
  });
}

/** Expand a boolean into complementary true/false outcomes. */
export function fromBoolean(answer: BooleanAnswer): Distribution<"true" | "false"> {
  const yes = probability(answer.probability, "probability");
  return {
    probabilities: { true: yes, false: 1 - yes },
    ...(answer.probabilitySource === undefined
      ? {}
      : { probabilitySource: answer.probabilitySource }),
  };
}

/** Rank outcomes, best first; ties preserve object enumeration order. */
export function rank<K extends string>(answer: Distribution<K>): Ranked<K>[] {
  return entries(answer).sort((left, right) => right.probability - left.probability);
}

/** Take at most count outcomes; zero returns an empty array. Invalid counts fail explicitly. */
export function topK<K extends string>(answer: Distribution<K>, count: number): Ranked<K>[] {
  return rank(answer).slice(0, integer(count, 0, "count"));
}

/** Difference between the two most probable outcomes, not a probability of correctness. */
export function margin<K extends string>(answer: Distribution<K>): number {
  const [first, second] = topK(answer, 2);
  return (first?.probability ?? 0) - (second?.probability ?? 0);
}

/** Sum the mass of a set of outcomes without assuming independence from other answers. */
export function probabilityOf<K extends string>(
  answer: Distribution<K>,
  predicate: (value: K) => boolean,
): number {
  return entries(answer).reduce(
    (total, entry) => total + (predicate(entry.value) ? entry.probability : 0),
    0,
  );
}

/**
 * Aggregate outcomes into coarser categories. The previous winner/confidence is intentionally dropped.
 * @example
 * Answer.coarsen(evidence, (intent) => intent === "refund" ? "billing" : "support");
 */
export function coarsen<K extends string, G extends string>(
  answer: Distribution<K>,
  group: (value: K) => G,
): Distribution<G> {
  const groups = new Map<G, number>();
  for (const entry of entries(answer)) {
    const key = group(entry.value);
    groups.set(key, (groups.get(key) ?? 0) + entry.probability);
  }
  return {
    probabilities: Object.fromEntries(groups) as Partial<Record<G, number>>,
    ...(answer.probabilitySource === undefined
      ? {}
      : { probabilitySource: answer.probabilitySource }),
  };
}

/** Calculate Σ probability × value. Non-finite callback values and overflow are rejected. */
export function expectedValue<K extends string>(
  answer: Distribution<K>,
  value: (outcome: K) => number,
): number {
  const total = entries(answer).reduce(
    (sum, entry) => sum + entry.probability * finite(value(entry.value), `value.${entry.value}`),
    0,
  );
  return finite(total, "expectedValue");
}

/** Boolean confidence uses |2P(true)-1|; other answers use their declared confidence metric. */
export function confidence(answer: AnyAnswer): number {
  return answer.type === "boolean"
    ? Math.abs(2 * probability(answer.probability, "probability") - 1)
    : probability(answer.confidence, "confidence");
}
