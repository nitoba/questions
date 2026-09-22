import type * as Policy from "./policy.ts";
import { definitions, isPolicy } from "./internal/policy-plan.ts";
import { decide } from "./internal/policy-condition.ts";
import type { OperationOptions } from "./lifecycle.ts";
import type { FieldDiagnostic } from "./diagnostics.ts";
import {
  checkModel,
  callSettings,
  operationContext,
  withOperation,
  type Settings,
} from "./internal/operation.ts";
import * as Schema from "./schema.ts";
import * as Question from "./question.ts";
import type { Evaluation, EvaluationRequest, QuestionModel } from "./model.ts";
import type { StateSource } from "./types.ts";
import { requireConfidence } from "./decision.ts";
import { abortable, cancellation } from "./internal/abort.ts";
import { decode } from "./internal/decode.ts";
import { probability, state } from "./internal/validation.ts";

/** Options for a new inference over captured inputs. A previous AbortSignal is never reused. */
export interface ReplayOptions extends OperationOptions {
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
  /** Correlates this run with its semantic lifecycle events. A replay gets a new ID. */
  readonly operationId: string;
  /** Field-level evidence for schema inputs, empty for plain batches. Does not call the model. */
  readonly diagnostics: readonly FieldDiagnostic[];
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

/** @internal One implementation behind the schema and question-batch overloads. */
export async function prepare(
  model: QuestionModel,
  source: StateSource,
  input: Question.Batch | Schema.Type | Policy.Definition<unknown>,
  options: OperationOptions = {},
  defaults?: Settings,
): Promise<Prepared<unknown>> {
  model = checkModel(model);
  const parent = operationContext(options);
  const policy = parent?.policy ?? callSettings(defaults, options);
  const minimum = policy.confidence;
  if (minimum !== undefined) probability(minimum, "confidence.minimum");
  options.signal?.throwIfAborted();
  const scope = cancellation(options.signal, parent ? undefined : policy.timeoutMs);
  const policyPlan = isPolicy(input) ? definitions.get(input)! : undefined;
  let compiled: ReturnType<typeof Schema.compile> | undefined;
  let questions: Readonly<Record<string, Question.AnyQuestion>>;
  let request: EvaluationRequest | undefined;
  const checkpoint = () => {
    parent?.check();
    scope.check();
  };
  try {
    checkpoint();
    // Compile before awaiting the source, so metadata cannot drift across that await.
    compiled = policyPlan?.schema ?? (Schema.isSchema(input) ? Schema.compile(input) : undefined);
    questions =
      policyPlan?.questions ??
      (compiled ? compiled.questions : Question.normalize(input as Question.Batch));
    checkpoint();
    if (Object.keys(questions).length > 0) {
      if (parent) parent.stage = "context";
      const current =
        typeof source === "function"
          ? await abortable(source({ signal: scope.signal }), scope.signal)
          : source;
      checkpoint();
      request = Object.freeze({ state: state(current), questions });
      checkpoint();
    }
  } finally {
    scope.dispose();
  }

  function execute(
    selected: QuestionModel,
    inherited: Settings,
    run: ReplayOptions,
    name: "run" | "replay",
  ): Promise<Execution<unknown>> {
    selected = checkModel(selected);
    return withOperation(selected, inherited, name, run, async (_options, context) => {
      const confidence = context.policy.confidence;
      const signal = context.signal;
      context.questionCount = Object.keys(questions).length;
      context.check();
      let evidence: Evaluation<Question.Batch> | undefined;
      if (request !== undefined) {
        context.stage = "inference";
        context.evaluationCount++;
        const response = await abortable(selected.evaluate(request, { signal }), signal);
        context.check();
        context.stage = "validation";
        evidence = decode(response, questions);
        context.evidence = evidence;
      }
      const parseOptions = { signal, ...(confidence === undefined ? {} : { confidence }) };
      context.stage = "validation";
      const diagnostics = compiled ? compiled.diagnose(evidence, parseOptions) : Object.freeze([]);
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
      context.check();
      context.stage = "decision";
      const selection = policyPlan ? decide(policyPlan, evidence) : undefined;
      context.check();
      const effective = context.policy;
      return Object.freeze({
        value: selection ? selection.value : value,
        ...(selection ? { trace: selection.trace } : {}),
        evidence,
        diagnostics,
        operationId: context.id,
        replay(next: ReplayOptions = {}) {
          return execute(next.model ?? selected, effective, next, "replay");
        },
      });
    });
  }

  return Object.freeze({
    request,
    run(run: ReplayOptions = {}) {
      return execute(run.model ?? model, policy, run, "run");
    },
  });
}
