import type { AnyQuestion, Batch } from "../question.ts";
import type { AnyAnswer } from "../answer.ts";
import type { SchemaPath } from "../diagnostics.ts";
import type {
  Condition,
  ConditionTrace,
  Limits,
  Outcome,
  Status,
  Thresholds,
  Trace,
} from "../policy.ts";
import type { Evaluation } from "../model.ts";
import type { Plan } from "./policy-plan.ts";
import { UncertainPolicyError, ValidationError } from "../errors.ts";
import { finite, probability, record } from "./validation.ts";

/** @internal Shared by all references and derived builders for one question definition. */
export interface Owner {
  readonly thresholds: Thresholds;
}
/** @internal An observation or a finite constant, with lossless schema paths. */
export type Source = {
  readonly path: SchemaPath;
} & (
  | {
      readonly id: string;
      readonly question: AnyQuestion;
      readonly choices?: Readonly<Record<string, Outcome>>;
    }
  | { readonly value: Outcome }
);
/** @internal Immutable condition algebra; composition never calculates joint probabilities. */
export type Node =
  | {
      readonly type: "leaf";
      readonly source: Source;
      readonly keys: readonly string[];
      readonly operator: "is" | "oneOf" | "atLeast" | "atMost";
      readonly expected: readonly Outcome[] | number;
      readonly thresholds: Thresholds;
    }
  | { readonly type: "and" | "or"; readonly left: Node; readonly right: Node }
  | { readonly type: "not"; readonly operand: Node };
const conditions = new WeakMap<
  object,
  { readonly owner: Owner; readonly node: Node; readonly depth: number }
>();

/** @internal Snapshot an explicit pair or resolve a per-condition override. */
export function thresholds(value: unknown, defaults?: Thresholds): Thresholds {
  const input = value === undefined && defaults ? {} : record(value, "policy.thresholds");
  for (const key of Object.keys(input))
    if (key !== "accept" && key !== "reject")
      throw new ValidationError("unknown cutoff", `policy.thresholds.${key}`);
  const accept = probability(
    input.accept === undefined ? defaults?.accept : input.accept,
    "policy.thresholds.accept",
  );
  const reject = probability(
    input.reject === undefined ? defaults?.reject : input.reject,
    "policy.thresholds.reject",
  );
  if (reject >= accept) throw new ValidationError("require reject < accept", "policy.thresholds");
  return Object.freeze({ accept, reject });
}

function entry(condition: Condition, owner: Owner) {
  const stored =
    typeof condition === "object" && condition !== null ? conditions.get(condition) : undefined;
  if (!stored || stored.owner !== owner)
    throw new ValidationError(
      "expected a condition from this policy's references",
      "policy.condition",
    );
  return stored;
}
/** @internal Reject booleans, promises, forged conditions and references from another policy. */
export function conditionNode(condition: Condition, owner: Owner): Node {
  return entry(condition, owner).node;
}

function condition(owner: Owner, node: Node, depth = 1): Condition {
  if (depth > 100)
    throw new ValidationError("condition nesting exceeds 100 levels", "policy.condition");
  const result: Condition = Object.freeze({
    and(other: Condition) {
      const next = entry(other, owner);
      return condition(
        owner,
        Object.freeze({ type: "and", left: node, right: next.node }),
        Math.max(depth, next.depth) + 1,
      );
    },
    or(other: Condition) {
      const next = entry(other, owner);
      return condition(
        owner,
        Object.freeze({ type: "or", left: node, right: next.node }),
        Math.max(depth, next.depth) + 1,
      );
    },
    not() {
      return condition(owner, Object.freeze({ type: "not", operand: node }), depth + 1);
    },
  });
  conditions.set(result, { owner, node, depth });
  return result;
}

/** @internal Build ordinary typed-reference objects. No proxies or callback source inspection. */
export function reference(owner: Owner, source: Source): unknown {
  const variants: readonly (readonly [string, Outcome])[] =
    "value" in source
      ? [["constant", source.value]]
      : source.question.type === "boolean"
        ? [
            ["true", true],
            ["false", false],
          ]
        : source.question.type === "score"
          ? source.question.criteria.map((_, index) => [String(index), index] as const)
          : Object.entries(
              source.choices ??
                Object.fromEntries(Object.keys(source.question.criteria).map((key) => [key, key])),
            );
  const values = new Map(variants.map(([key, value]) => [value, key]));
  function selected(requested: readonly Outcome[], operator: "is" | "oneOf", limits?: Limits) {
    if (!Array.isArray(requested) || requested.length === 0)
      throw new ValidationError("expected at least one outcome", "policy.condition.outcomes");
    const distinct = [...new Set(requested)];
    const keys = distinct.map((value) => {
      const key = values.get(value);
      if (key === undefined)
        throw new ValidationError(
          "outcome is not declared by this question",
          "policy.condition.outcome",
        );
      return key;
    });
    return condition(
      owner,
      Object.freeze({
        type: "leaf",
        source,
        keys: Object.freeze(keys),
        operator,
        expected: Object.freeze(distinct),
        thresholds: thresholds(limits, owner.thresholds),
      }),
    );
  }
  const common = {
    is(value: Outcome, limits?: Limits) {
      return selected([value], "is", limits);
    },
    oneOf(values: readonly Outcome[], limits?: Limits) {
      return selected(values, "oneOf", limits);
    },
  };
  if (variants.every(([, value]) => typeof value === "boolean"))
    return Object.freeze({ is: common.is });
  if (!variants.every(([, value]) => typeof value === "number")) return Object.freeze(common);
  function numeric(operator: "atLeast" | "atMost", threshold: number, limits?: Limits) {
    finite(threshold, "policy.condition.level");
    const keys = variants
      .filter(([, value]) =>
        operator === "atLeast" ? (value as number) >= threshold : (value as number) <= threshold,
      )
      .map(([key]) => key);
    return condition(
      owner,
      Object.freeze({
        type: "leaf",
        source,
        keys: Object.freeze(keys),
        operator,
        expected: threshold,
        thresholds: thresholds(limits, owner.thresholds),
      }),
    );
  }
  return Object.freeze({
    ...common,
    atLeast(value: number, limits?: Limits) {
      return numeric("atLeast", value, limits);
    },
    atMost(value: number, limits?: Limits) {
      return numeric("atMost", value, limits);
    },
  });
}

function classify(mass: number, limits: Thresholds): Status {
  if (mass >= limits.accept) return "match";
  if (mass <= limits.reject) return "miss";
  // Addition/complement rounding at inclusive boundaries is not semantic uncertainty.
  const accepted = limits.accept - mass;
  const rejected = mass - limits.reject;
  if (accepted <= Number.EPSILON * 4 && accepted < rejected) return "match";
  if (rejected <= Number.EPSILON * 4 && rejected < accepted) return "miss";
  return "uncertain";
}
function interpret(
  node: Node,
  answers: Readonly<Record<string, AnyAnswer>>,
  cache: Map<Node, ConditionTrace>,
): ConditionTrace {
  const previous = cache.get(node);
  if (previous) return previous;
  let trace: ConditionTrace;
  if (node.type === "leaf") {
    const answer = "id" in node.source ? answers[node.source.id]! : undefined;
    const mass =
      answer === undefined
        ? node.keys.includes("constant")
          ? 1
          : 0
        : answer.type === "boolean"
          ? node.keys.reduce(
              (total, key) =>
                total + (key === "true" ? answer.probability : 1 - answer.probability),
              0,
            )
          : node.keys.reduce((total, key) => total + answer.probabilities[key]!, 0);
    trace = Object.freeze({
      type: answer === undefined ? "constant" : "question",
      status: classify(mass, node.thresholds),
      ...("id" in node.source ? { questionId: node.source.id } : {}),
      path: node.source.path,
      operator: node.operator,
      expected: node.expected,
      probability: mass,
      ...(answer?.probabilitySource === undefined
        ? {}
        : { probabilitySource: answer.probabilitySource }),
      thresholds: node.thresholds,
    });
  } else if (node.type === "not") {
    const operand = interpret(node.operand, answers, cache);
    trace = Object.freeze({
      type: "not",
      status:
        operand.status === "uncertain"
          ? "uncertain"
          : operand.status === "match"
            ? "miss"
            : "match",
      operand,
    });
  } else {
    const left = interpret(node.left, answers, cache);
    const right = interpret(node.right, answers, cache);
    const status: Status =
      node.type === "and"
        ? left.status === "miss" || right.status === "miss"
          ? "miss"
          : left.status === "uncertain" || right.status === "uncertain"
            ? "uncertain"
            : "match"
        : left.status === "match" || right.status === "match"
          ? "match"
          : left.status === "uncertain" || right.status === "uncertain"
            ? "uncertain"
            : "miss";
    trace = Object.freeze({
      type: node.type,
      status,
      operands: Object.freeze([left, right] as const),
    });
  }
  cache.set(node, trace);
  return trace;
}

/** @internal Interpret only validated observations, after existing confidence and schema gates. */
export function decide(
  plan: Plan,
  evidence: Evaluation<Batch> | undefined,
): { readonly value: unknown; readonly trace: Trace } {
  const rules: Trace["rules"][number][] = [];
  const cache = new Map<Node, ConditionTrace>();
  for (const [index, rule] of plan.rules.entries()) {
    const condition = interpret(rule.condition, evidence?.answers ?? {}, cache);
    rules.push(Object.freeze({ index, status: condition.status, condition }));
    if (condition.status === "miss") continue;
    const trace: Trace = Object.freeze({
      rules: Object.freeze(rules),
      selected: Object.freeze({ kind: condition.status === "match" ? "rule" : "uncertain", index }),
    });
    if (condition.status === "match") return { value: rule.value, trace };
    if (plan.uncertain === undefined) throw new UncertainPolicyError(trace, evidence);
    return { value: plan.uncertain.value, trace };
  }
  return {
    value: plan.otherwise,
    trace: Object.freeze({
      rules: Object.freeze(rules),
      selected: Object.freeze({ kind: "otherwise" }),
    }),
  };
}
