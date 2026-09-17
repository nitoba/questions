import type { Input as DurationInput } from "./duration.ts";
import type { Usage } from "./model.ts";
import type { Awaitable, RunOptions } from "./types.ts";

/** A public semantic operation, not an HTTP attempt. Preparation itself performs no evaluation. */
export type Operation =
  | "ask"
  | "run"
  | "replay"
  | "evidence"
  | "is"
  | "probability"
  | "score"
  | "choose"
  | "rank"
  | "branch"
  | "each.ask"
  | "each.is"
  | "each.score";
/** Stage of a failed semantic operation. A branch handler executes after its accepted decision. */
export type Stage = "prepare" | "context" | "inference" | "validation" | "decision" | "handler";
/** Read-only correlation metadata, deliberately excluding prompts, values and credentials. */
export interface EvaluationEvent {
  readonly operationId: string;
  readonly operation: Operation;
  readonly provider: string;
  readonly elapsedMs: number;
  readonly signal: AbortSignal;
}
/** A validated operation result. For branch(), emitted before the selected handler is called. */
export interface DecisionEvent extends EvaluationEvent {
  /** Count of provider.evaluate calls, not HTTP retries. Zero for constants or empty batches. */
  readonly evaluationCount: number;
  readonly questionCount: number;
  readonly itemCount: number;
  /** Absent for no inference; missing counters remain unknown rather than zero. */
  readonly usage?: Usage;
  readonly model?: string;
}
/** Safe classification; the original thrown error is returned to the caller, not telemetry. */
export interface OperationErrorEvent extends DecisionEvent {
  readonly stage: Stage;
  readonly kind:
    | "provider"
    | "validation"
    | "schema"
    | "uncertain"
    | "timeout"
    | "aborted"
    | "application";
  readonly status?: number;
}
/** Semantic hooks may be asynchronous. No hook is retried. */
export type SemanticHook<T> = (event: Readonly<T>) => Awaitable<void>;
/** false removes inherited callbacks for this event. Arrays compose in parent-first order. */
export type SemanticHooksList<T> = SemanticHook<T> | readonly SemanticHook<T>[] | false;
/**
 * Observability for complete Questions operations, independent of the provider protocol.
 * onEvaluate starts before context acquisition; onDecision follows validation and confidence.
 * onError observes terminal failures, including schema/uncertainty, without exposing raw errors.
 * Hook failures propagate unchanged and do not recursively invoke onError. On cancellation,
 * onError is notified without waiting for asynchronous cleanup; the cancellation reason wins.
 * @example
 * Questions.create({ model, hooks: {
 *   onEvaluate: ({ operationId }) => console.log("Started", operationId),
 *   onDecision: ({ usage, elapsedMs }) => console.log(usage, elapsedMs),
 *   onError: ({ kind, stage }) => console.log(kind, stage),
 * } });
 */
export interface SemanticHooks {
  readonly onEvaluate?: SemanticHooksList<EvaluationEvent>;
  readonly onDecision?: SemanticHooksList<DecisionEvent>;
  readonly onError?: SemanticHooksList<OperationErrorEvent>;
}
/** Defaults contain policies only, never a signal whose lifetime could leak into another run. */
export interface Defaults {
  readonly confidence?: number;
  /** Total operation budget, including context, hooks, provider retries and Zod. false clears it. */
  readonly timeout?: DurationInput | false;
  /** @deprecated Use timeout. */
  readonly timeoutMs?: number;
}
/** Per-call overrides take precedence over client defaults. Schema minimums cannot be weakened. */
export interface OperationOptions extends Defaults, RunOptions {
  /** Adds callbacks to inherited hooks; false disables all inherited semantic hooks for this call. */
  readonly hooks?: SemanticHooks | false;
}
