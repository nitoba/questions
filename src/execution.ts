import * as Schema from "./schema.ts";
import * as Question from "./question.ts";
import type { Evaluation, EvaluationRequest, QuestionModel } from "./model.ts";
import type { RunOptions, StateSource } from "./types.ts";
import { requireConfidence } from "./decision.ts";
import { abortable, cancellation } from "./internal/abort.ts";
import { decode } from "./internal/decode.ts";
import { probability, state, text } from "./internal/validation.ts";

/** Options for a new inference over captured inputs. A previous AbortSignal is never reused. */
export interface ReplayOptions extends RunOptions {
  /** Override the provider explicitly, for example to compare the same inputs on another host. */
  readonly model?: QuestionModel;
  /** Override the call-level confidence gate; per-field schema minimums still apply. */
  readonly confidence?: number;
}
/**
 * An immutable record of one successful run. value retains the schema's own mutability rules.
 * Evidence is validated/frozen. This is in-memory state, not a durable journal or a cache.
 */
export interface Execution<T, B extends Question.Batch = Question.Batch> {
  readonly value: T;
  /** Undefined for constant-only schemas, which perform no inference. */
  readonly evidence: Evaluation<B> | undefined;
  /**
   * Perform a NEW inference over the same snapshotted context and questions, then parse again.
   * Keeps the last provider and confidence policy unless overridden, but never its AbortSignal.
   * Does not reread live context or replay business handlers. May incur another provider charge.
   * User Zod callbacks execute again; side effects inside transforms remain your responsibility.
   * @example
   * const first = await questions.about(ticket).run(schema);
   * const second = await first.replay({ signal: AbortSignal.timeout(15_000) });
   * console.log(first.value, second.value);
   */
  replay(options?: ReplayOptions): Promise<Execution<T, B>>;
}
/**
 * A captured evaluation that can also be rerun after a failure, when no Execution was returned.
 * Preparing resolves live context once but calls neither the provider nor Zod parse callbacks.
 */
export interface Prepared<T, B extends Question.Batch = Question.Batch> {
  /** Frozen context and normalized questions; can contain sensitive application data. */
  readonly request: EvaluationRequest | undefined;
  /** Every call starts fresh work. No implicit deduplication, reuse, retries or persistence. */
  run(options?: ReplayOptions): Promise<Execution<T, B>>;
}

function checkModel(model: QuestionModel) {
  text(model.name, "model.name");
  if (typeof model.evaluate !== "function")
    throw new TypeError("model.evaluate must be a function");
}

/** @internal One implementation behind the schema and question-batch overloads. */
export async function prepare(
  model: QuestionModel,
  source: StateSource,
  input: Question.Batch | Schema.Type,
  options: Schema.Options = {},
): Promise<Prepared<unknown>> {
  checkModel(model);
  const minimum = options.confidence;
  if (minimum !== undefined) probability(minimum, "confidence.minimum");
  options.signal?.throwIfAborted();
  // Compile synchronously before awaiting the source, so metadata cannot drift across that await.
  const compiled = Schema.isSchema(input) ? Schema.compile(input) : undefined;
  const questions = compiled ? compiled.questions : Question.normalize(input as Question.Batch);
  const scope = cancellation(options.signal);
  let request: EvaluationRequest | undefined;
  try {
    scope.signal.throwIfAborted();
    if (Object.keys(questions).length > 0) {
      const current =
        typeof source === "function"
          ? await abortable(source({ signal: scope.signal }), scope.signal)
          : source;
      scope.signal.throwIfAborted();
      request = Object.freeze({ state: state(current), questions });
    }
  } finally {
    scope.dispose();
  }

  async function execute(
    selected: QuestionModel,
    confidence: number | undefined,
    signal?: AbortSignal,
  ): Promise<Execution<unknown>> {
    checkModel(selected);
    if (confidence !== undefined) probability(confidence, "confidence.minimum");
    const runScope = cancellation(signal);
    try {
      runScope.signal.throwIfAborted();
      const evidence =
        request === undefined
          ? undefined
          : decode(
              await abortable(
                selected.evaluate(request, { signal: runScope.signal }),
                runScope.signal,
              ),
              questions,
            );
      runScope.signal.throwIfAborted();
      const parseOptions = {
        signal: runScope.signal,
        ...(confidence === undefined ? {} : { confidence }),
      };
      const value = compiled
        ? await compiled.parse(evidence, parseOptions)
        : Object.freeze(
            Object.fromEntries(
              Object.entries(evidence!.answers).map(([key, answer]) => {
                if (confidence !== undefined)
                  requireConfidence(answer, confidence, questions[key]!.instructions);
                return [
                  key,
                  answer.type === "boolean"
                    ? answer.probability >= 0.5
                    : answer.type === "choice"
                      ? answer.choice
                      : answer.score,
                ];
              }),
            ),
          );
      runScope.signal.throwIfAborted();
      return Object.freeze({
        value,
        evidence,
        replay(next: ReplayOptions = {}) {
          return execute(next.model ?? selected, next.confidence ?? confidence, next.signal);
        },
      });
    } finally {
      runScope.dispose();
    }
  }
  return Object.freeze({
    request,
    run(run: ReplayOptions = {}) {
      return execute(run.model ?? model, run.confidence ?? minimum, run.signal);
    },
  });
}
