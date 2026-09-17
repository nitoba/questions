import type { ProviderError } from "./errors.ts";
import type { Awaitable } from "./types.ts";

/** Read-only HTTP attempt metadata. Never contains a URL, headers, credentials or prompt. */
export interface AttemptContext {
  readonly provider: string;
  /** One-based attempt number, local to this HTTP operation. */
  readonly attempt: number;
  /** Wall-clock duration of this HTTP operation, including earlier retries and hooks. */
  readonly elapsedMs: number;
  readonly signal: AbortSignal;
}
/** Headers have arrived. This does not imply valid JSON, valid evidence or a successful decision. */
export interface ResponseContext extends AttemptContext {
  readonly status: number;
}
/** A transport failure, sanitized by Questions rather than exposing ofetch's request context. */
export interface FailureContext extends AttemptContext {
  readonly error: ProviderError;
}
/** A retry of a failed attempt, not a fresh semantic evaluation or a business action. */
export interface RetryContext extends FailureContext {
  readonly nextAttempt: number;
  readonly retryAfterMs?: number;
}
/** The chosen delay includes Retry-After. An abort or a throwing hook can still prevent retry. */
export interface RetryEvent extends RetryContext {
  readonly delayMs: number;
}
/** Async hooks are awaited sequentially. Throwing stops the operation without retrying the hook. */
export type Hook<T> = (context: Readonly<T>) => Awaitable<void>;
/** One hook or an ordered list, snapshotted when the provider is created. */
export type HooksList<T> = Hook<T> | readonly Hook<T>[];
/**
 * Observability hooks for transports owned by Questions. Not mutable ofetch interceptors.
 * onError observes final transport/body-read failures, not schema or application failures.
 * User callback errors and caller cancellation are not recursively passed to onError.
 * @example
 * const model = TypeSafe.create({ apiKey, hooks: {
 *   onRequest: ({ attempt }) => console.log("Attempt", attempt),
 *   onRetry: ({ nextAttempt, delayMs }) => console.log("Retry", nextAttempt, delayMs),
 * } });
 */
export interface Hooks {
  readonly onRequest?: HooksList<AttemptContext>;
  readonly onResponse?: HooksList<ResponseContext>;
  readonly onRetry?: HooksList<RetryEvent>;
  readonly onError?: HooksList<FailureContext>;
}
/**
 * Opt-in HTTP retry policy. Does not retry decoding, evidence validation, Zod or handlers.
 * POST retries can duplicate upstream work and billing; no exactly-once guarantee is implied.
 */
export interface RetryOptions {
  /** Additional attempts, in [0, 10]. maxRetries: 2 permits three total HTTP attempts. */
  readonly maxRetries: number;
  /** Retryable HTTP statuses. Default: [429, 529], preserving the original TypeSafe policy. */
  readonly statusCodes?: readonly number[];
  /** Explicitly retry network failures of unknown delivery status. Default: false. */
  readonly networkErrors?: boolean;
  /** Initial exponential delay, default 200ms. Ignored when delayMs is specified. */
  readonly initialDelayMs?: number;
  /** Maximum wait, default 30s. A larger Retry-After stops retries, never shortens it. */
  readonly maxDelayMs?: number;
  /** Full jitter for exponential backoff, default true. Not applied to an explicit delayMs. */
  readonly jitter?: boolean;
  /**
   * Fixed delay or synchronous policy, in milliseconds. Retry-After remains a lower bound.
   * Values above maxDelayMs stop retries; invalid values fail without another request.
   * @example
   * { maxRetries: 3, delayMs: ({ attempt }) => attempt * 500 }
   */
  readonly delayMs?: number | ((context: Readonly<RetryContext>) => number);
}
/** false disables retry; a number is shorthand for { maxRetries }. Disabled by default. */
export type Retry = false | number | RetryOptions;
