import { confidence, expectedValue } from "./answer.ts";
import type { AnyAnswer, Distribution } from "./answer.ts";
import { UncertainDecision, ValidationError } from "./errors.ts";
import { distribution } from "./internal/decode.ts";
import { finite, probability, record } from "./internal/validation.ts";

/** A constant cost, complete outcome table, or pure cost function. Negative costs are rewards. */
export type Loss<K extends string> =
  | number
  | Readonly<Record<K, number>>
  | ((outcome: K) => number);
/** Expected loss of one available action. */
export interface Risk<A extends string> {
  readonly choice: A;
  readonly expectedLoss: number;
}
/** Selected action and all evaluated alternatives, without executing any handler. */
export interface Selection<A extends string> extends Risk<A> {
  readonly alternatives: readonly Risk<A>[];
}

/**
 * Reject insufficient confidence and preserve the original evidence on success.
 * Boolean confidence is the yes/no margin, not P(true).
 * @throws UncertainDecision when the policy rejects the answer.
 */
export function requireConfidence<A extends AnyAnswer>(
  answer: A,
  minimum: number,
  question?: string,
): A {
  probability(minimum, "confidence.minimum");
  const observed = confidence(answer);
  if (observed < minimum) throw new UncertainDecision(observed, minimum, question, answer);
  return answer;
}

/**
 * Evaluate each action's expected loss. Requires normalized, nonempty evidence and finite costs.
 * Missing cost-table entries fail even for zero-probability outcomes. Ties retain input order.
 * @example
 * const costs = { approve: { safe: 0, unsafe: 100 }, review: 2 };
 * const alternatives = Decision.risks(evidence, costs);
 */
export function risks<K extends string, const C extends Readonly<Record<string, Loss<NoInfer<K>>>>>(
  evidence: Distribution<K>,
  costs: C,
): Risk<keyof C & string>[] {
  const outcomes = Object.keys(record(evidence.probabilities, "probabilities")) as K[];
  if (outcomes.length === 0)
    throw new ValidationError("nonempty evidence is required", "probabilities");
  distribution(evidence.probabilities, outcomes, "probabilities");
  const actions = Object.entries(record(costs, "costs"));
  if (actions.length === 0) throw new ValidationError("at least one action is required", "costs");
  return actions.map(([choice, unknownLoss]) => {
    const loss = unknownLoss as Loss<K>;
    const expectedLoss = expectedValue(evidence, (outcome) => {
      if (typeof loss === "function") return finite(loss(outcome), `costs.${choice}.${outcome}`);
      if (typeof loss === "number") return finite(loss, `costs.${choice}`);
      const table = record(loss, `costs.${choice}`);
      if (!Object.hasOwn(table, outcome))
        throw new ValidationError("missing outcome cost", `costs.${choice}.${outcome}`);
      return finite(table[outcome], `costs.${choice}.${outcome}`);
    });
    return { choice: choice as keyof C & string, expectedLoss };
  });
}

/** Choose the lowest expected loss; never invoke application code as a side effect. */
export function minimizeLoss<
  K extends string,
  const C extends Readonly<Record<string, Loss<NoInfer<K>>>>,
>(evidence: Distribution<K>, costs: C): Selection<keyof C & string> {
  const alternatives = risks(evidence, costs);
  let selected = alternatives[0]!;
  for (const risk of alternatives) if (risk.expectedLoss < selected.expectedLoss) selected = risk;
  return { ...selected, alternatives };
}

/**
 * Invoke exactly the selected lazy handler. Synchronous and asynchronous return types are preserved.
 * The record must contain every choice admitted by the evidence type.
 */
export function match<K extends string, const H extends Readonly<Record<K, () => unknown>>>(
  evidence: { readonly choice: K },
  handlers: H,
): ReturnType<H[K]> {
  if (
    !Object.hasOwn(handlers, evidence.choice) ||
    typeof handlers[evidence.choice] !== "function"
  ) {
    throw new ValidationError("selected handler is missing", "handlers");
  }
  return handlers[evidence.choice]() as ReturnType<H[K]>;
}
