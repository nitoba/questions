import type { AnyAnswer } from "./answer.ts";
import type { AnyQuestion } from "./question.ts";
import type { Resolved } from "./schema-annotations.ts";

/** Lossless Zod input path; numeric tuple indices are distinct from string object keys. */
export type SchemaPath = readonly (string | number)[];
/** One generated question and its origin in the INPUT schema, before any output transform. */
export interface SchemaField {
  readonly questionId: string;
  readonly path: SchemaPath;
  /** Presence decisions share a path with their value decision, but have a different ID. */
  readonly role: "presence" | "value";
  readonly question: AnyQuestion;
  readonly annotations: Readonly<Resolved>;
  /** Maps wire option IDs to original primitive values, including undefined. */
  readonly choices?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}
/**
 * Evidence joined to an input field without inference, parsing callbacks or fabricated explanations.
 * Contains question guidance and potentially sensitive model judgments; never sent to hooks by default.
 * Passing confidence is not a guarantee of factual correctness or successful Zod validation.
 */
export interface FieldDiagnostic extends SchemaField {
  readonly answer: AnyAnswer;
  /** False when an ancestor presence decision omits this field. Evidence is still wire-validated. */
  readonly active: boolean;
  readonly confidence: number;
  /** Only active fields have an effective threshold, including operation and union-variant minima. */
  readonly minimum?: number;
  readonly confidencePassed?: boolean;
}
