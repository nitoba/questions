import type * as z from "zod/v4/core";
import * as Question from "./question.ts";
import * as Schema from "./schema.ts";
import type { JsonValue } from "./types.ts";
import type { Execution as BaseExecution, ReplayOptions } from "./execution.ts";
import type { ProbabilitySource } from "./answer.ts";
import type { SchemaPath } from "./diagnostics.ts";
import { ValidationError } from "./errors.ts";
import { json } from "./internal/validation.ts";
import { conditionNode, reference, thresholds, type Owner } from "./internal/policy-condition.ts";
import { schemaReferences } from "./internal/policy-schema.ts";
import { definitions, type Plan, type Rule } from "./internal/policy-plan.ts";

/** Static JSON results, not functions, promises or business handlers. */
export type Value = JsonValue | undefined;
/** Probability cutoffs. Values between reject and accept remain uncertain. */
export interface Thresholds {
  readonly accept: number;
  readonly reject: number;
}
/** Probability cutoffs are explicit; confidence gates remain separate constraints. */
export interface Options {
  readonly thresholds: Thresholds;
}
/** Override either cutoff for one condition; the resolved pair must satisfy reject < accept. */
export type Limits = Partial<Thresholds>;
/** Three-valued interpretation of evidence. A miss is not an uncertain match. */
export type Status = "match" | "miss" | "uncertain";
/** Primitive outcomes represented by finite questions and Zod literal alternatives. */
export type Outcome = string | number | boolean | null | undefined;

/**
 * An immutable condition description, not a JavaScript boolean or a model answer.
 * Use .and()/.or(), never &&/||. Composition does not assume independence of probabilities.
 */
export interface Condition {
  /** Both conditions must match. A miss dominates uncertainty. */
  and(other: Condition): Condition;
  /** Either condition may match. A match dominates uncertainty. */
  or(other: Condition): Condition;
  /** Swap match and miss; uncertainty remains uncertain. */
  not(): Condition;
}
/** A typed reference to a yes/no question's evidence. */
export interface BooleanReference<T extends boolean = boolean> {
  /** Test P(value), not the winner or a provider-specific confidence metric. */
  is(value: T, limits?: Limits): Condition;
}
/** A typed reference to a finite set of outcomes. */
export interface ChoiceReference<T extends Outcome> {
  /** Compare the probability mass of this outcome with the resolved cutoffs. */
  is(value: T, limits?: Limits): Condition;
  /** Sum the mass of these distinct outcomes. An empty set is rejected. */
  oneOf(values: readonly T[], limits?: Limits): Condition;
}
/** A score rubric or finite numeric choice. Comparisons use mass, not the weighted mean. */
export interface NumberReference<T extends number = number> extends ChoiceReference<T> {
  /** Test P(level >= minimum). Rubric levels are zero-based; no joint probability is inferred. */
  atLeast(minimum: number, limits?: Limits): Condition;
  /** Test P(level <= maximum), using the same probability cutoffs. */
  atMost(maximum: number, limits?: Limits): Condition;
}
/** References mirror required input objects and fixed tuples, not transformed Zod outputs. */
export type References<T> = [T] extends [boolean]
  ? BooleanReference<T & boolean>
  : [T] extends [number]
    ? NumberReference<T & number>
    : [T] extends [Outcome]
      ? ChoiceReference<T & Outcome>
      : { readonly [K in keyof T]: References<T[K]> };
/** Preserve native choice keys and distinguish score rubrics from yes/no questions. */
export type BatchReferences<B extends Question.Batch> = {
  readonly [K in keyof B]: B[K] extends string | Question.BooleanQuestion
    ? BooleanReference
    : B[K] extends Question.ScoreQuestion
      ? NumberReference
      : B[K] extends Question.ChoiceQuestion<infer C>
        ? ChoiceReference<C>
        : never;
};

/** Evidence and exact cutoffs used by one condition. No model-generated explanation. */
export type ConditionTrace =
  | {
      readonly type: "question" | "constant";
      readonly status: Status;
      readonly questionId?: string;
      readonly path: SchemaPath;
      readonly operator: "is" | "oneOf" | "atLeast" | "atMost";
      readonly expected: readonly Outcome[] | number;
      readonly probability: number;
      readonly probabilitySource?: ProbabilitySource;
      readonly thresholds: Thresholds;
    }
  | {
      readonly type: "and" | "or";
      readonly status: Status;
      readonly operands: readonly [ConditionTrace, ConditionTrace];
    }
  | {
      readonly type: "not";
      readonly status: Status;
      readonly operand: ConditionTrace;
    };
/** Ordered rules reached by this execution. Later rules are not evaluated after uncertainty. */
export interface Trace {
  readonly rules: readonly {
    readonly index: number;
    readonly status: Status;
    readonly condition: ConditionTrace;
  }[];
  readonly selected:
    | { readonly kind: "rule" | "uncertain"; readonly index: number }
    | { readonly kind: "otherwise" };
}

/** A policy execution keeps the existing replay contract: every replay is NEW inference. */
export interface Execution<T, B extends Question.Batch = Question.Batch> extends BaseExecution<
  T,
  B
> {
  readonly trace: Trace;
  /** Re-evaluate captured inputs and reapply this policy; never execute business handlers. */
  replay(options?: ReplayOptions): Promise<Execution<T, B>>;
}

declare const definitionType: unique symbol;
/** An opaque, immutable, executable policy. Obtain one by ending a builder with .otherwise(). */
export interface Definition<T, B extends Question.Batch = Question.Batch> {
  readonly [definitionType]: { readonly value: T; readonly batch: B };
}
/** Infer a policy's exact union of static results. */
export type Output<P extends Definition<unknown>> = P extends Definition<infer T> ? T : never;
/** An immutable rule builder. Every callback runs once now, not during inference. */
export interface Builder<R, T = never, B extends Question.Batch = Question.Batch> {
  /** Append a rule in priority order. Values are snapshotted; no handlers are accepted. */
  when<const V extends Value>(
    condition: (questions: R) => Condition,
    value: V,
  ): Builder<R, T | V, B>;
  /** Handle the first uncertain rule. Without this, decide/run throw UncertainPolicyError. */
  onUncertain<const V extends Value>(value: V): Builder<R, T | V, B>;
  /** Finish the policy. This value is used only when every rule misses, never for errors. */
  otherwise<const V extends Value>(value: V): Definition<T | V, B>;
}

function snapshot<V extends Value>(value: V): V {
  return (value === undefined ? undefined : json(value, "policy.value")) as V;
}

function builder<R, T, B extends Question.Batch>(
  owner: Owner,
  references: R,
  base: Pick<Plan, "questions" | "schema">,
  rules: readonly Rule[] = [],
  uncertain?: { readonly value: Value },
): Builder<R, T, B> {
  return Object.freeze({
    when<const V extends Value>(condition: (questions: R) => Condition, value: V) {
      if (typeof condition !== "function")
        throw new ValidationError("expected a condition-building callback", "policy.when");
      const built = condition(references);
      if (
        built !== null &&
        typeof built === "object" &&
        "then" in built &&
        typeof built.then === "function"
      ) {
        // Invalid async callbacks can reject later. Observe them without accepting async construction.
        void Promise.resolve(built).catch(() => {});
        throw new ValidationError("condition callbacks must be synchronous", "policy.when");
      }
      const node = conditionNode(built, owner);
      return builder<R, T | V, B>(
        owner,
        references,
        base,
        Object.freeze([...rules, Object.freeze({ condition: node, value: snapshot(value) })]),
        uncertain,
      );
    },
    onUncertain<const V extends Value>(value: V) {
      if (uncertain !== undefined)
        throw new ValidationError("onUncertain is already defined", "policy.onUncertain");
      return builder<R, T | V, B>(
        owner,
        references,
        base,
        rules,
        Object.freeze({ value: snapshot(value) }),
      );
    },
    otherwise<const V extends Value>(value: V): Definition<T | V, B> {
      const definition = Object.freeze({}) as Definition<T | V, B>;
      definitions.set(
        definition,
        Object.freeze({
          ...base,
          rules,
          uncertain,
          otherwise: snapshot(value),
        }),
      );
      return definition;
    },
  });
}

/**
 * Build a policy from required, shape-preserving Zod decisions. Refinements still run locally.
 * Transforms, presence wrappers and probability-number fields are rejected before inference;
 * use boolean evidence for probability thresholds. ask(schema) keeps its broader schema support.
 * @example
 * const policy = Policy.from(z.object({ urgent: z.boolean() }), {
 *   thresholds: { accept: 0.8, reject: 0.2 },
 * }).when(({ urgent }) => urgent.is(true), "act").onUncertain("review").otherwise("wait");
 */
export function from<S extends Schema.Type>(
  schema: S,
  options: Options,
): Builder<References<z.input<S>>>;
/**
 * Build a policy from native questions, preserving choice keys and literal result unions.
 * One execution evaluates the declared batch once, regardless of how often rules refer to it.
 * @example
 * const policy = Policy.from({ urgent: Question.boolean("Is it urgent?") }, {
 *   thresholds: { accept: 0.8, reject: 0.2 },
 * }).when(({ urgent }) => urgent.is(true), "act").onUncertain("review").otherwise("wait");
 * const result = await questions.about(ticket).decide(policy);
 */
export function from<const B extends Question.Batch>(
  batch: B,
  options: Options,
): Builder<BatchReferences<B>, never, B>;
export function from(input: Question.Batch | Schema.Type, options: Options): Builder<unknown> {
  const owner: Owner = Object.freeze({ thresholds: thresholds(options?.thresholds) });
  if (Schema.isSchema(input)) {
    const { compiled, references } = schemaReferences(input, owner);
    return builder(owner, references, { questions: compiled.questions, schema: compiled });
  }
  const questions = Question.normalize(input);
  const references = Object.freeze(
    Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [
        key,
        reference(owner, { id: key, path: Object.freeze([key]), question }),
      ]),
    ),
  );
  return builder(owner, references, { questions, schema: undefined });
}
