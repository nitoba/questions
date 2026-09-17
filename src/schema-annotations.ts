import * as z from "zod/v4/core";
import type { ScoreQuestion } from "./question.ts";
import { ValidationError } from "./errors.ts";
import { json, probability, record, text } from "./internal/validation.ts";

/** Natural-language guidance. Only these documented fields are sent to the provider. */
export interface Hints {
  /** Overrides the inferred question; descriptions and ancestor context remain available. */
  readonly instructions?: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON examples of the decision, not extra data to extract or allowed output values. */
  readonly examples?: readonly unknown[];
  /** Additional minimum confidence. Cannot weaken a parent or call-level minimum. */
  readonly confidence?: number;
}

/**
 * Typed annotations for finite decisions. The schema is still the runtime validator.
 * Numbers require an explicit probability or score meaning; no scale is guessed.
 */
export type Annotation = Hints &
  (
    | {
        readonly kind?: "boolean";
        readonly criteria?: { readonly true: string; readonly false: string };
        readonly options?: never;
        readonly levels?: never;
      }
    | {
        readonly kind: "probability";
        readonly criteria?: { readonly true: string; readonly false: string };
        readonly options?: never;
        readonly levels?: never;
      }
    | {
        readonly kind: "score";
        readonly levels: ScoreQuestion["criteria"];
        readonly options?: never;
        readonly criteria?: never;
      }
    | {
        readonly kind?: "choice";
        /** Descriptions keyed by string enum values. Missing descriptions use the value itself. */
        readonly options?: Readonly<Record<string, string | null>>;
        readonly criteria?: never;
        readonly levels?: never;
      }
  );

/** Use `satisfies Schema.Metadata` to type-check the Questions namespace inside `.meta()`. */
export interface Metadata {
  readonly title?: string;
  readonly description?: string;
  readonly examples?: readonly unknown[];
  readonly questions?: Annotation;
  readonly [key: string]: unknown;
}

/**
 * Native Zod registry for Questions annotations. Apply `.register()` to the final schema
 * instance; Zod methods such as `.refine()` may create a new instance without its metadata.
 * @example
 * z.number().min(0).max(1).register(Schema.registry, {
 *   kind: "probability", instructions: "Will this ticket need escalation?",
 * });
 */
export const registry = z.registry<Annotation>();

/**
 * Register typed annotations and return the exact same schema, preserving all Zod methods.
 * This mutates the registry entry, not the schema. Equivalent to `.register(Schema.registry, ...)`.
 * Explicit registry fields override `schema.meta().questions` field by field.
 * @example
 * const priority = Schema.annotate(z.number(), {
 *   kind: "score", levels: ["Low", "Medium", "High"],
 *   instructions: "How urgent is this ticket?",
 * });
 */
export function annotate<S extends z.$ZodType>(schema: S, annotation: Annotation): S {
  registry.add(schema, annotation);
  return schema;
}

/** @internal Normalized, snapshotted annotations consumed by the compiler. */
export interface Resolved extends Hints {
  readonly kind?: "boolean" | "choice" | "probability" | "score";
  readonly criteria?: { readonly true: string; readonly false: string };
  readonly options?: Readonly<Record<string, string | null>>;
  readonly levels?: ScoreQuestion["criteria"];
}

const annotationKeys = new Set([
  "instructions",
  "title",
  "description",
  "examples",
  "confidence",
  "kind",
  "criteria",
  "options",
  "levels",
]);

function annotationObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  const result = record(value, path);
  for (const key of Object.keys(result)) {
    if (!annotationKeys.has(key))
      throw new ValidationError("unknown Questions annotation", `${path}.${key}`);
  }
  return result;
}

/** @internal Read only approved metadata; never forward arbitrary application metadata. */
export function metadata(schema: z.$ZodType, path: string): Resolved {
  const global = z.globalRegistry.get(schema) ?? {};
  const raw: Record<string, unknown> = {
    ...(global.title !== undefined ? { title: global.title } : {}),
    ...(global.description !== undefined ? { description: global.description } : {}),
    ...(global.examples !== undefined ? { examples: global.examples } : {}),
    ...annotationObject(global.questions, `${path}.meta.questions`),
    ...annotationObject(registry.get(schema), `${path}.annotations`),
  };
  // Validate and snapshot before any request or user validation/transform callback runs.
  for (const key of ["instructions", "title", "description"] as const) {
    if (raw[key] !== undefined) text(raw[key], `${path}.${key}`);
  }
  if (raw.confidence !== undefined) probability(raw.confidence, `${path}.confidence`);
  if (
    raw.kind !== undefined &&
    (typeof raw.kind !== "string" ||
      !["boolean", "choice", "probability", "score"].includes(raw.kind))
  ) {
    throw new ValidationError("unknown decision kind", `${path}.kind`);
  }
  if (raw.examples !== undefined && !Array.isArray(raw.examples)) {
    throw new ValidationError("expected an array of JSON examples", `${path}.examples`);
  }
  if (raw.criteria !== undefined) {
    const criteria = record(raw.criteria, `${path}.criteria`);
    if (
      Object.keys(criteria).length !== 2 ||
      !Object.hasOwn(criteria, "true") ||
      !Object.hasOwn(criteria, "false")
    )
      throw new ValidationError("expected exactly true and false criteria", `${path}.criteria`);
    text(criteria.true, `${path}.criteria.true`);
    text(criteria.false, `${path}.criteria.false`);
  }
  if (raw.options !== undefined) {
    for (const [key, value] of Object.entries(record(raw.options, `${path}.options`))) {
      if (value !== null) text(value, `${path}.options[${JSON.stringify(key)}]`);
    }
  }
  if (raw.levels !== undefined) {
    if (!Array.isArray(raw.levels) || raw.levels.length < 2)
      throw new ValidationError("expected at least two score levels", `${path}.levels`);
    raw.levels.forEach((level, index) => text(level, `${path}.levels[${index}]`));
  }
  // `json` rejects non-finite numbers, cycles, class instances and unsafe non-JSON values.
  return json(
    Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)),
    path,
  ) as Resolved;
}
