import type { SchemaPath, FieldDiagnostic } from "./diagnostics.ts";
/** A malformed question, context, option, or provider response. */
export class ValidationError extends Error {
  readonly name = "ValidationError";
  readonly path: string;
  constructor(message: string, path = "input", options?: ErrorOptions) {
    super(`${path}: ${message}`, options);
    this.path = path;
  }
}

/** A transport failure. Response bodies and credentials are deliberately not retained. */
export class ProviderError extends Error {
  readonly name = "ProviderError";
  readonly provider: string;
  readonly status: number | undefined;
  readonly kind: "http" | "network" | "response";
  constructor(
    provider: string,
    kind: ProviderError["kind"],
    message: string,
    options: ErrorOptions & { readonly status?: number } = {},
  ) {
    super(message, options);
    this.provider = provider;
    this.kind = kind;
    this.status = options.status;
  }
}

/** The evaluation exceeded its total time budget, including retry delays. */
export class TimeoutError extends Error {
  readonly name = "TimeoutError";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Evaluation exceeded ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** A successful inference rejected by the application's confidence policy. */
export class UncertainDecision extends Error {
  readonly name = "UncertainDecision";
  readonly confidence: number;
  readonly minimum: number;
  readonly question: string | undefined;
  readonly evidence: unknown;
  /** Available for schema-backed decisions, using the input field path. */
  readonly path: SchemaPath | undefined;
  readonly questionId: string | undefined;
  readonly diagnostics: readonly FieldDiagnostic[] | undefined;
  constructor(
    confidence: number,
    minimum: number,
    question?: string,
    evidence?: unknown,
    details: {
      readonly path?: SchemaPath;
      readonly questionId?: string;
      readonly diagnostics?: readonly FieldDiagnostic[];
    } = {},
  ) {
    super(`Confidence ${confidence} is below the required ${minimum}`);
    this.confidence = confidence;
    this.minimum = minimum;
    this.question = question;
    this.evidence = evidence;
    this.path = details.path;
    this.questionId = details.questionId;
    this.diagnostics = details.diagnostics;
  }
}
