import type * as Schema from "../schema.ts";
import type * as Question from "../question.ts";
import type { Definition, Value } from "../policy.ts";
import type { Node } from "./policy-condition.ts";

/** @internal A rule contains static data, never an application handler. */
export interface Rule {
  readonly condition: Node;
  readonly value: Value;
}
/** @internal Shared immutable questions and ordered rules behind an opaque policy. */
export interface Plan {
  readonly questions: Readonly<Record<string, Question.AnyQuestion>>;
  readonly schema: Schema.Compiled<Schema.Type> | undefined;
  readonly rules: readonly Rule[];
  readonly uncertain: { readonly value: Value } | undefined;
  readonly otherwise: Value;
}
/** @internal Weak ownership prevents forged policy objects or mutable public plans. */
export const definitions = new WeakMap<object, Plan>();
/** @internal Not a duck-typed question batch or schema. */
export function isPolicy(input: unknown): input is Definition<unknown> {
  return typeof input === "object" && input !== null && definitions.has(input);
}
