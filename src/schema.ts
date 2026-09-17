import type { SchemaField, FieldDiagnostic } from "./diagnostics.ts";
import * as z from "zod/v4/core";
import type { AnyQuestion } from "./question.ts";
import type { RunOptions } from "./types.ts";
import { plan } from "./internal/schema-compiler.ts";
import { decode } from "./internal/decode.ts";
import { abortable } from "./internal/abort.ts";
import { probability } from "./internal/validation.ts";
import { UncertainDecision, ValidationError } from "./errors.ts";

export { annotate, registry } from "./schema-annotations.ts";
export type { Annotation, Hints, Metadata } from "./schema-annotations.ts";
/** Zod 4 Core, Classic and Mini schemas share this contract. */
export type Type = z.$ZodType;
/** Infer the validated output, including transforms, brands, defaults and readonly modifiers. */
export type Output<S extends Type> = z.output<S>;
/** Cancellation and a global minimum confidence applied before Zod validation or transforms. */
export interface Options extends RunOptions {
  readonly confidence?: number;
}

/** A well-formed provider decision that failed the user's Zod schema. No automatic retries. */
export class SchemaValidationError extends Error {
  readonly name = "SchemaValidationError";
  /** Original Zod issues with paths; `cause` retains the original Zod error. */
  readonly issues: readonly z.$ZodIssue[];
  /** Input-field evidence, including gates; no generated explanations or extra inference. */
  readonly diagnostics: readonly FieldDiagnostic[];
  constructor(error: z.$ZodError, diagnostics: readonly FieldDiagnostic[] = []) {
    super("The decision result does not satisfy the supplied Zod schema", { cause: error });
    this.issues = Object.freeze([...error.issues]);
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/** A reusable compiled plan. Metadata is snapshotted; every parse runs the original schema. */
export interface Compiled<S extends Type> {
  readonly schema: S;
  /** Input paths, annotations, option mappings and question IDs captured at compilation. */
  readonly fields: readonly SchemaField[];
  /**
   * Validate and join evidence to fields without inference, Zod callbacks or enforcing confidence.
   * Optional absent branches are retained but marked inactive; paths refer to schema inputs.
   * @example
   * const plan = Schema.compile(schema);
   * const evidence = await q.evidence(plan.questions);
   * const fields = plan.diagnose(evidence, { confidence: 0.7 });
   * console.log(fields.filter(field => field.active && !field.confidencePassed));
   */
  diagnose(evaluation?: unknown, options?: Options): readonly FieldDiagnostic[];
  /** Collision-free transport IDs. Use with `q.evidence()` for advanced evidence processing. */
  readonly questions: Readonly<Record<string, AnyQuestion>>;
  /**
   * Validate provider evidence, reconstruct the schema input and run async Zod parsing.
   * For a constant-only schema, omit evidence; no inference or live context is needed.
   * Provider contract failures remain ValidationError; user validation failures become
   * SchemaValidationError. Exceptions thrown by user callbacks keep their original identity.
   */
  parse(evaluation?: unknown, options?: Options): Promise<Output<S>>;
}

/** @internal Discriminate Zod schemas from the existing plain-object question batch API. */
export function isSchema(value: unknown): value is Type {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    typeof value._zod === "object" &&
    value._zod !== null &&
    "def" in value._zod
  );
}

/**
 * Compile supported Zod inputs into a finite provider-neutral question batch.
 * Supports objects, fixed tuples, booleans, enums, primitive literal unions, optional/nullable
 * fields and annotated numbers. Output transforms and refinements run locally, once per parse.
 * Free-form extraction, variable arrays and recursive schemas fail before inference.
 * @example
 * const schema = z.object({ urgent: z.boolean().describe("Is production blocked?") });
 * const compiled = Schema.compile(schema);
 * const evidence = await questions.about(ticket).evidence(compiled.questions);
 * const result = await compiled.parse(evidence); // { urgent: boolean }
 * @example
 * // The usual API compiles and validates for you:
 * const result = await questions.about(ticket).ask(schema);
 */
export function compile<S extends Type>(schema: S): Compiled<S> {
  if (!isSchema(schema)) throw new ValidationError("expected a Zod 4 schema", "schema");
  const compiled = plan(schema);
  return Object.freeze({
    schema,
    questions: compiled.questions,
    fields: compiled.fields,
    diagnose(evaluation?: unknown, options: Options = {}) {
      if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
      options.signal?.throwIfAborted();
      const answers =
        Object.keys(compiled.questions).length === 0
          ? {}
          : decode(evaluation, compiled.questions).answers;
      return compiled.diagnose(answers, options.confidence ?? 0);
    },
    async parse(evaluation?: unknown, options: Options = {}): Promise<Output<S>> {
      if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
      options.signal?.throwIfAborted();
      const answers =
        Object.keys(compiled.questions).length === 0
          ? {}
          : decode(evaluation, compiled.questions).answers;
      const diagnostics = compiled.diagnose(answers, options.confidence ?? 0);
      let input: unknown;
      try {
        input = compiled.read(answers, options.confidence ?? 0);
      } catch (error) {
        if (!(error instanceof UncertainDecision)) throw error;
        throw new UncertainDecision(
          error.confidence,
          error.minimum,
          error.question,
          error.evidence,
          {
            ...(error.path === undefined ? {} : { path: error.path }),
            ...(error.questionId === undefined ? {} : { questionId: error.questionId }),
            diagnostics,
          },
        );
      }
      options.signal?.throwIfAborted();
      const parsing = z.safeParseAsync(schema, input);
      const result = options.signal ? await abortable(parsing, options.signal) : await parsing;
      options.signal?.throwIfAborted();
      if (!result.success) throw new SchemaValidationError(result.error, diagnostics);
      return result.data;
    },
  });
}

export type { SchemaField, SchemaPath, FieldDiagnostic } from "./diagnostics.ts";
