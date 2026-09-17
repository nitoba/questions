import type {
  Defaults,
  OperationOptions,
  SemanticHooks,
  SemanticHooksList,
  SemanticHook,
  EvaluationEvent,
  DecisionEvent,
  OperationErrorEvent,
  Operation,
  Stage,
} from "../lifecycle.ts";
import type { Evaluation, QuestionModel } from "../model.ts";
import type { Batch } from "../question.ts";
import { resolve as duration } from "./duration.ts";
import { ProviderError, TimeoutError, UncertainDecision, ValidationError } from "../errors.ts";
import { SchemaValidationError } from "../schema.ts";
import { abortable, cancellation } from "./abort.ts";
import { probability, record, text } from "./validation.ts";

/** @internal Fully snapshotted policies; AbortSignals are intentionally not retained. */
export interface Settings {
  readonly confidence: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly hooks: {
    readonly onEvaluate: readonly SemanticHook<EvaluationEvent>[];
    readonly onDecision: readonly SemanticHook<DecisionEvent>[];
    readonly onError: readonly SemanticHook<OperationErrorEvent>[];
  };
}

function list<T>(
  previous: readonly SemanticHook<T>[],
  next: SemanticHooksList<T> | undefined,
  name: string,
): readonly SemanticHook<T>[] {
  if (next === false) return Object.freeze([]);
  const added = next === undefined ? [] : Array.isArray(next) ? [...next] : [next];
  if (added.some((hook) => typeof hook !== "function"))
    throw new ValidationError(
      "expected a function, an array of functions, or false",
      `hooks.${name}`,
    );
  return Object.freeze([...previous, ...added]) as readonly SemanticHook<T>[];
}

/** @internal Parent < derived < call; undefined inherits, false clears timeout/hooks. */
export function settings(
  previous?: Settings,
  defaults: Defaults = {},
  hooks?: SemanticHooks | false,
): Settings {
  record(defaults, "defaults");
  for (const key of Object.keys(defaults)) {
    if (!["confidence", "timeout", "timeoutMs"].includes(key))
      throw new ValidationError(
        "unknown default; signals and hooks do not belong in defaults",
        `defaults.${key}`,
      );
  }
  const confidence = defaults.confidence === undefined ? previous?.confidence : defaults.confidence;
  if (confidence !== undefined) probability(confidence, "confidence.minimum");
  if (defaults.timeout === false && defaults.timeoutMs !== undefined)
    throw new ValidationError("supply timeout or timeoutMs, not both", "timeout");
  const timeoutMs =
    defaults.timeout === false
      ? undefined
      : (duration(defaults.timeout, defaults.timeoutMs, "timeout", 1) ?? previous?.timeoutMs);
  if (hooks !== undefined && hooks !== false) {
    record(hooks, "hooks");
    for (const key of Object.keys(hooks))
      if (!["onEvaluate", "onDecision", "onError"].includes(key))
        throw new ValidationError("unknown semantic hook", `hooks.${key}`);
  }
  const base = hooks === false ? undefined : previous?.hooks;
  const next = hooks === false ? undefined : hooks;
  return Object.freeze({
    confidence,
    timeoutMs,
    hooks: Object.freeze({
      onEvaluate: list(base?.onEvaluate ?? [], next?.onEvaluate, "onEvaluate"),
      onDecision: list(base?.onDecision ?? [], next?.onDecision, "onDecision"),
      onError: list(base?.onError ?? [], next?.onError, "onError"),
    }),
  });
}

/** @internal Normalize each call once, preventing mutation during asynchronous work. */
export function callSettings(previous: Settings | undefined, options: OperationOptions): Settings {
  return settings(
    previous,
    {
      ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    options.hooks,
  );
}

/** @internal Snapshot callable model properties without mutating the application's model. */
export function checkModel(model: QuestionModel): QuestionModel {
  text(model.name, "model.name");
  if (typeof model.evaluate !== "function")
    throw new TypeError("model.evaluate must be a function");
  return Object.freeze({ name: model.name, evaluate: model.evaluate.bind(model) });
}

/** @internal One owned operation scope, shared by nested implementation steps. */
export interface OperationContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly policy: Settings;
  /** Enforce the monotonic deadline whenever control returns from user code. */
  check(): void;
  stage: Stage;
  itemCount: number;
  questionCount: number;
  evaluationCount: number;
  evidence: Evaluation<Batch> | undefined;
  /** Emit at most once, before a branch handler or after a value is validated. */
  decision(): Promise<void>;
}

/** @internal Never retry semantic work or user callbacks. No global execution context. */
export async function operate<T>(
  model: QuestionModel,
  operation: Operation,
  policy: Settings,
  signal: AbortSignal | undefined,
  work: (context: OperationContext) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const scope = cancellation(signal, policy.timeoutMs);
  const started = performance.now();
  const id = crypto.randomUUID();
  let hookFailed = false;
  let decided = false;
  const event = (): EvaluationEvent =>
    Object.freeze({
      operationId: id,
      operation,
      provider: model.name,
      elapsedMs: performance.now() - started,
      signal: scope.signal,
    });
  async function emit<E>(hooks: readonly SemanticHook<E>[], value: E) {
    for (const hook of hooks) {
      scope.check();
      try {
        await abortable(hook(value), scope.signal);
      } catch (error) {
        if (!scope.signal.aborted) hookFailed = true;
        throw error;
      }
    }
    scope.check();
  }
  const context: OperationContext = {
    id,
    signal: scope.signal,
    policy,
    check: scope.check,
    stage: "prepare",
    itemCount: 1,
    questionCount: 0,
    evaluationCount: 0,
    evidence: undefined,
    async decision() {
      if (decided) return;
      scope.check();
      decided = true;
      await emit(
        policy.hooks.onDecision,
        Object.freeze({
          ...event(),
          evaluationCount: context.evaluationCount,
          questionCount: context.questionCount,
          itemCount: context.itemCount,
          ...(context.evidence === undefined
            ? {}
            : { usage: context.evidence.usage, model: context.evidence.model }),
        }),
      );
    },
  };
  try {
    if (policy.hooks.onEvaluate.length > 0) await emit(policy.hooks.onEvaluate, event());
    const value = await abortable(work(context), scope.signal);
    scope.check();
    await context.decision();
    return value;
  } catch (thrown) {
    const error = scope.signal.aborted ? scope.signal.reason : thrown;
    if (!hookFailed) {
      const kind: OperationErrorEvent["kind"] =
        error instanceof TimeoutError
          ? "timeout"
          : scope.signal.aborted
            ? "aborted"
            : error instanceof ProviderError
              ? "provider"
              : error instanceof UncertainDecision
                ? "uncertain"
                : error instanceof SchemaValidationError
                  ? "schema"
                  : error instanceof ValidationError
                    ? "validation"
                    : "application";
      const failure: OperationErrorEvent = Object.freeze({
        ...event(),
        kind,
        stage: error instanceof UncertainDecision ? "decision" : context.stage,
        evaluationCount: context.evaluationCount,
        questionCount: context.questionCount,
        itemCount: context.itemCount,
        ...(context.evidence === undefined
          ? {}
          : { usage: context.evidence.usage, model: context.evidence.model }),
        ...(error instanceof ProviderError && error.status !== undefined
          ? { status: error.status }
          : {}),
      });
      if (scope.signal.aborted) {
        // Cancellation wins. Notify finalizers, observe late rejections, never wait indefinitely.
        for (const hook of policy.hooks.onError) {
          try {
            void Promise.resolve(hook(failure)).catch(() => {});
          } catch {
            /* Preserve cancellation. */
          }
        }
      } else await emit(policy.hooks.onError, failure);
    }
    throw error;
  } finally {
    scope.dispose();
  }
}

const contextKey: unique symbol = Symbol("questions.operation");
type ScopedOptions = OperationOptions & { readonly [contextKey]?: OperationContext };
/** @internal Explicit scope propagation avoids AsyncLocalStorage and duplicate nested hooks. */
export function operationContext(options: OperationOptions): OperationContext | undefined {
  return (options as ScopedOptions)[contextKey];
}

/** @internal Public methods create a scope; their implementation calls reuse it explicitly. */
export function withOperation<T>(
  model: QuestionModel,
  inherited: Settings | undefined,
  name: Operation,
  options: OperationOptions,
  work: (options: OperationOptions, context: OperationContext) => Promise<T>,
): Promise<T> {
  const existing = operationContext(options);
  if (existing) {
    existing.check();
    return work(options, existing);
  }
  const policy = callSettings(inherited, options);
  return operate(model, name, policy, options.signal, (context) => {
    const scoped: ScopedOptions = Object.freeze({
      timeout: policy.timeoutMs ?? false,
      signal: context.signal,
      ...(policy.confidence === undefined ? {} : { confidence: policy.confidence }),
      [contextKey]: context,
    });
    return work(scoped, context);
  });
}
