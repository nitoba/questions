import type { ChoiceAnswer, ScoreAnswer } from "../answer.ts";
import { margin } from "../answer.ts";
import type { AnyQuestion } from "../question.ts";
import { normalize } from "../question.ts";
import type { EvaluationRequest, QuestionModel } from "../model.ts";
import type { RunOptions, State, JsonObject } from "../types.ts";
import { ValidationError } from "../errors.ts";
import { abortable, cancellation } from "../internal/abort.ts";
import { customHeaders } from "../internal/http.ts";
import { decode } from "../internal/decode.ts";
import { exactKeys, json, probability, record, state, text } from "../internal/validation.ts";

/** The subset of Evaluation V4 call options consumed by this bridge. No SDK type dependency. */
export interface EvaluationCall {
  readonly state: State;
  readonly questions: Readonly<Record<string, AnyQuestion>>;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly providerOptions?: Record<string, JsonObject>;
}
/**
 * Structural Evaluation V4 contract, compatible with official AI SDK evaluation models.
 * Results remain unknown intentionally: the bridge validates them before exposing typed evidence.
 * This is not a language-model interface. Methods may return any PromiseLike implementation.
 */
export interface EvaluationModel {
  readonly specificationVersion: "v4";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedQuestionTypes: readonly ("boolean" | "choice" | "score")[];
  doEvaluate(options: EvaluationCall): PromiseLike<unknown>;
}
/** Validated evidence without a guessed or provider-supplied confidence value. */
export type ConfidenceEvidence =
  | Omit<ChoiceAnswer, "confidence" | "confidenceSource">
  | Omit<ScoreAnswer, "confidence" | "confidenceSource">;
/** Context for a pure, synchronous confidence policy. No secrets or raw HTTP data. */
export interface ConfidenceContext {
  readonly questionId: string;
  readonly question: AnyQuestion;
  readonly modelId: string;
  readonly provider: string;
}
/**
 * Margin is P(first)-P(second). A custom function must return a finite number in [0, 1].
 * Neither policy is automatically equivalent to TypeSafe's proprietary confidence metric.
 */
export type ConfidencePolicy =
  | "margin"
  | ((evidence: ConfidenceEvidence, context: ConfidenceContext) => number);

/** Adapt an existing AI SDK evaluation model without taking ownership of its configuration. */
export interface Options {
  readonly model: EvaluationModel;
  /** Applies to choice and score only. Boolean confidence remains |2P(true)-1|. Default: margin. */
  readonly confidence?: ConfidencePolicy;
  /** Explicit provider namespaces, validated/snapshotted as finite JSON. No implicit routing policy. */
  readonly providerOptions?: Record<string, JsonObject>;
  readonly headers?: HeadersInit;
  /** Evaluation budget including the SDK call. Cannot forcibly stop a non-cooperative SDK model. */
  readonly timeoutMs?: number;
}

/**
 * Adapt an AI SDK EvaluationModelV4 to Questions. Calls doEvaluate exactly once, without the
 * AI SDK core evaluate function's default retries. SDK authentication, routing and network
 * policy remain owned by the supplied model. Use Vercel.create for our bounded HTTP preset.
 *
 * Complete distributions are required for choice/score. Missing probabilities fail instead
 * of inventing certainty. All evidence is validated before custom confidence callbacks run.
 * SDK errors keep their identity; cancellation preserves the caller's signal.reason.
 * @example
 * const gateway = createGateway({ apiKey });
 * const model = AISDK.create({ model: gateway.evaluationModel("typesafe-ai/jev") });
 * const result = await Questions.create({ model }).about(ticket).ask(schema);
 * @example
 * // Configure OIDC/BYOK/headers in the official SDK, then reuse its evaluation model.
 * const model = AISDK.create({ model: existingModel, timeoutMs: 15_000 });
 */
export function create(options: Options): QuestionModel {
  const model = options.model;
  if (
    model === null ||
    typeof model !== "object" ||
    model.specificationVersion !== "v4" ||
    typeof model.doEvaluate !== "function"
  )
    throw new ValidationError(
      "expected an AI SDK EvaluationModelV4, not a language model",
      "model",
    );
  const modelId = text(model.modelId, "model.modelId");
  const provider = text(model.provider, "model.provider");
  if (
    !Array.isArray(model.supportedQuestionTypes) ||
    model.supportedQuestionTypes.some((type) => !["boolean", "choice", "score"].includes(type))
  )
    throw new ValidationError("invalid supportedQuestionTypes", "model.supportedQuestionTypes");
  const supported = new Set(model.supportedQuestionTypes);
  const evaluate = model.doEvaluate.bind(model);
  const policy = options.confidence ?? "margin";
  if (policy !== "margin" && typeof policy !== "function")
    throw new ValidationError("expected margin or a confidence function", "confidence");
  const headers = customHeaders(options.headers);
  const namespaces = record(options.providerOptions ?? {}, "providerOptions");
  for (const [key, value] of Object.entries(namespaces)) record(value, `providerOptions.${key}`);
  const providerOptions = json(namespaces, "providerOptions") as Record<string, JsonObject>;
  const timeoutMs = options.timeoutMs;
  cancellation(undefined, timeoutMs).dispose();

  return Object.freeze({
    name: provider,
    async evaluate(request: EvaluationRequest, run: RunOptions = {}): Promise<unknown> {
      run.signal?.throwIfAborted();
      const questions = normalize(request.questions);
      for (const [id, question] of Object.entries(questions)) {
        if (!supported.has(question.type))
          throw new ValidationError(
            `evaluation model does not support ${question.type}`,
            `questions.${id}.type`,
          );
      }
      const context = state(request.state);
      const scope = cancellation(run.signal, timeoutMs);
      try {
        // Structural types align with Evaluation V4; the JSON boundary is validated above.
        const result: unknown = await abortable(
          evaluate({
            state: context,
            questions,
            headers: Object.fromEntries(headers),
            providerOptions: structuredClone(providerOptions),
            abortSignal: scope.signal,
          }),
          scope.signal,
        );
        scope.signal.throwIfAborted();
        const raw = record(result, "response");
        const answers = record(raw.answers, "response.answers");
        exactKeys(answers, Object.keys(questions), "response.answers");
        const response =
          raw.response === undefined ? undefined : record(raw.response, "response.response");
        const envelope = {
          model: response?.modelId === undefined ? modelId : response.modelId,
          usage: raw.usage === undefined ? {} : raw.usage,
          rounding: raw.rounding,
          warnings: raw.warnings,
          providerMetadata: raw.providerMetadata,
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, question]) => {
              const answer = record(answers[id], `response.answers.${id}`);
              if (question.type === "boolean") return [id, answer];
              if (answer.probabilities === undefined)
                throw new ValidationError(
                  "Questions requires a complete probability distribution; this model did not supply one",
                  `response.answers.${id}.probabilities`,
                );
              return [
                id,
                {
                  ...answer,
                  confidence: 0,
                  ...(question.type === "score"
                    ? {
                        legend: Object.fromEntries(
                          question.criteria.map((label, index) => [String(index), label]),
                        ),
                      }
                    : {}),
                },
              ];
            }),
          ),
        };
        // First pass checks the ENTIRE batch, including metadata and rounding, before callbacks.
        const validated = decode(envelope, questions);
        const projected = Object.fromEntries(
          Object.entries(validated.answers).map(([id, answer]) => {
            scope.signal.throwIfAborted();
            if (answer.type === "boolean") return [id, answer];
            const { confidence: _confidence, confidenceSource: _source, ...evidence } = answer;
            const confidence = probability(
              policy === "margin"
                ? margin(evidence)
                : policy(
                    Object.freeze(evidence),
                    Object.freeze({
                      questionId: id,
                      question: questions[id]!,
                      modelId: validated.model,
                      provider,
                    }),
                  ),
              `response.answers.${id}.confidence`,
            );
            return [
              id,
              {
                ...evidence,
                confidence,
                confidenceSource: policy === "margin" ? "margin" : "custom",
              },
            ];
          }),
        );
        scope.signal.throwIfAborted();
        return decode({ ...validated, answers: projected }, questions);
      } finally {
        scope.dispose();
      }
    },
  });
}
