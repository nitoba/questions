import {
  generateText,
  jsonSchema,
  Output,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
} from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Input as DurationInput } from "../duration.ts";
import type { EvaluationRequest, QuestionModel } from "../model.ts";
import type { AnyAnswer } from "../answer.ts";
import type { JsonObject, RunOptions } from "../types.ts";
import type { ConfidencePolicy } from "./ai-sdk.ts";
import { ProviderError, ValidationError } from "../errors.ts";
import { normalize } from "../question.ts";
import { decode } from "../internal/decode.ts";
import { abortable, cancellation } from "../internal/abort.ts";
import { resolve as duration } from "../internal/duration.ts";
import { customHeaders } from "../internal/http.ts";
import { finite, integer, json, probability, record, state, text } from "../internal/validation.ts";
import { plan, PROMPT_VERSION, SYSTEM_PROMPT } from "../internal/generative-plan.ts";

export { PROMPT_VERSION } from "../internal/generative-plan.ts";

/** A configured AI SDK 7 language model; IDs/implicit Gateway routing are intentionally excluded. */
export type Model = LanguageModelV4;

/**
 * Generate finite decisions with a language model capable of structured JSON output.
 * Model authentication and HTTP configuration remain owned by the supplied SDK instance.
 */
export interface Options {
  readonly model: Model;
  /** Required acknowledgement: all probabilities are elicited estimates, never calibration guarantees. */
  readonly evidence: "estimated";
  /** Diagnostic label only. Defaults to `<SDK provider>.generative`. Do not put secrets here. */
  readonly name?: string;
  /** Margin by default. Pure custom policies run only after the ENTIRE response is validated. */
  readonly confidence?: ConfidencePolicy;
  /** Total evaluation budget, including SDK retries. No timeout by default. */
  readonly timeout?: DurationInput;
  /** SDK transport retries, off by default. Not output-repair retries. Maximum 10. */
  readonly maxRetries?: number;
  /** Default 4096. A truncated generation fails instead of yielding a partial decision. */
  readonly maxOutputTokens?: number;
  /** Passed through explicitly; no assumed model-specific temperature or reasoning setting. */
  readonly temperature?: number;
  readonly providerOptions?: Record<string, JsonObject>;
  readonly headers?: HeadersInit;
  /** Default 128. Larger batches can exceed a provider's structured-output limits. */
  readonly maxQuestions?: number;
  /** Default 255 alternatives/levels per question. Provider limits may be lower. */
  readonly maxCriteria?: number;
  /** Default 1 MiB. Bounds serialized prompt plus schema before dispatch, not serialization memory. */
  readonly maxPromptBytes?: number;
  /** Default 1 MiB. Checks generated text AFTER buffering; not a transport response-byte limit. */
  readonly maxOutputBytes?: number;
}

/**
 * Adapt a configured AI SDK language model using a fixed prompt and strict structured output.
 * Boolean probabilities and full choice/score distributions are explicitly marked `estimated`.
 * Choice, weighted score and margin are calculated locally, not generated redundantly.
 * No tools, automatic prompt repair, schema relaxation, fallback, or partial decision emission.
 *
 * Import only from `@nitoba/questions/providers/generative`; install the optional `ai` peer.
 * The existing evaluation-model adapter is separate and is not weakened by this provider.
 * @example
 * const questions = Questions.create({
 *   model: Generative.create({ model: google(modelId), evidence: "estimated", timeout: "20 s" }),
 * });
 * const run = await questions.about(ticket).run(schema);
 * console.log(run.evidence?.answers, run.diagnostics);
 * @example
 * // Reuse the exact same schema with another configured SDK language model.
 * const comparison = await run.replay({
 *   model: Generative.create({ model: anthropic(modelId), evidence: "estimated" }),
 * });
 * @throws ValidationError for invalid options, requests, metadata or custom confidence values.
 * @throws ProviderError for unusable output, invalid distributions, truncation or refusal.
 * SDK transport errors and exceptions from custom confidence callbacks retain their identity.
 */
export function create(options: Options): QuestionModel {
  if (options.evidence !== "estimated")
    throw new ValidationError('explicitly set evidence: "estimated"', "evidence");
  const supplied = options.model;
  if (
    supplied === null ||
    typeof supplied !== "object" ||
    supplied.specificationVersion !== "v4" ||
    typeof supplied.doGenerate !== "function" ||
    typeof supplied.doStream !== "function"
  )
    throw new ValidationError(
      "expected a configured AI SDK LanguageModelV4, not an ID or evaluation model",
      "model",
    );
  const modelId = text(supplied.modelId, "model.modelId");
  const provider = text(supplied.provider, "model.provider");
  const name = text(options.name ?? `${provider}.generative`, "name");
  // Capture methods/binding while leaving SDK authentication in its original closure.
  const model: Model = Object.freeze({
    specificationVersion: "v4",
    provider,
    modelId,
    get supportedUrls() {
      return supplied.supportedUrls;
    },
    doGenerate: supplied.doGenerate.bind(supplied),
    doStream: supplied.doStream.bind(supplied),
  });
  const policy = options.confidence ?? "margin";
  if (policy !== "margin" && typeof policy !== "function")
    throw new ValidationError("expected margin or a confidence function", "confidence");
  const headers = customHeaders(options.headers);
  const namespaces = record(options.providerOptions ?? {}, "providerOptions");
  for (const [key, value] of Object.entries(namespaces)) record(value, `providerOptions.${key}`);
  const providerOptions = json(namespaces, "providerOptions") as Record<string, JsonObject>;
  const timeoutMs = duration(options.timeout, undefined, "timeout", 1);
  cancellation(undefined, timeoutMs).dispose();
  const maxRetries = integer(options.maxRetries ?? 0, 0, "maxRetries");
  if (maxRetries > 10) throw new ValidationError("at most 10 retries", "maxRetries");
  const maxOutputTokens = integer(options.maxOutputTokens ?? 4096, 1, "maxOutputTokens");
  const maxQuestions = integer(options.maxQuestions ?? 128, 1, "maxQuestions");
  const maxCriteria = integer(options.maxCriteria ?? 255, 2, "maxCriteria");
  const maxPromptBytes = integer(options.maxPromptBytes ?? 1_048_576, 1, "maxPromptBytes");
  const maxOutputBytes = integer(options.maxOutputBytes ?? 1_048_576, 1, "maxOutputBytes");
  const temperature =
    options.temperature === undefined ? undefined : finite(options.temperature, "temperature");
  if (temperature !== undefined && temperature < 0)
    throw new ValidationError("expected nonnegative temperature", "temperature");
  const encoder = new TextEncoder();
  return Object.freeze({
    name,
    async evaluate(request: EvaluationRequest, run: RunOptions = {}): Promise<unknown> {
      const scope = cancellation(run.signal, timeoutMs);
      try {
        scope.check();
        const questions = normalize(request.questions);
        const compiled = plan(questions, maxQuestions, maxCriteria);
        const prompt = JSON.stringify({ state: state(request.state), questions: compiled.rubrics });
        if (
          encoder.encode(SYSTEM_PROMPT + prompt + JSON.stringify(compiled.schema)).byteLength >
          maxPromptBytes
        )
          throw new ValidationError("serialized prompt exceeds maxPromptBytes", "request");
        scope.check();
        // A validating JSON Schema boundary avoids importing Zod into this subpath.
        const schema = jsonSchema<Readonly<Record<string, AnyAnswer>>>(compiled.schema, {
          validate(value) {
            try {
              return { success: true, value: compiled.read(value) };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error : new Error("Invalid generated distribution"),
              };
            }
          },
        });
        const result = await abortable(
          generateText({
            model,
            system: SYSTEM_PROMPT,
            prompt,
            output: Output.object({
              schema,
              name: "questions_decisions",
              description: "Estimated finite decision distributions",
            }),
            maxRetries,
            maxOutputTokens,
            ...(temperature === undefined ? {} : { temperature }),
            headers: Object.fromEntries(headers),
            providerOptions: structuredClone(providerOptions),
            abortSignal: scope.signal,
          }),
          scope.signal,
        ).catch((error: unknown) => {
          scope.check();
          if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error))
            throw new ProviderError(
              name,
              "response",
              "The language model did not return valid decision distributions",
            );
          throw error;
        });
        scope.check();
        if (result.finishReason !== "stop" || result.toolCalls.length > 0)
          throw new ProviderError(
            name,
            "response",
            "The language model did not complete a decision-only response",
          );
        if (encoder.encode(result.text).byteLength > maxOutputBytes)
          throw new ProviderError(name, "response", "Generated text exceeds maxOutputBytes");
        const metadata = result.finalStep.providerMetadata ?? {};
        if (Object.hasOwn(metadata, "questionsGenerative"))
          throw new ValidationError(
            "reserved provider metadata namespace",
            "response.providerMetadata.questionsGenerative",
          );
        // decode validates all evidence AND metadata before any user confidence callback runs.
        const validated = decode(
          {
            model: result.finalStep.response.modelId ?? modelId,
            usage: result.usage,
            answers: result.output,
            warnings: result.warnings,
            providerMetadata: {
              ...metadata,
              questionsGenerative: {
                probabilitySource: "estimated",
                strategy: "prompted-distribution",
                promptVersion: PROMPT_VERSION,
                requestedModel: modelId,
                provider,
              },
            },
          },
          questions,
        );
        scope.check();
        if (policy === "margin") return validated;
        const answers = Object.fromEntries(
          Object.entries(validated.answers).map(([id, answer]) => {
            scope.check();
            if (answer.type === "boolean") return [id, answer];
            const { confidence: _confidence, confidenceSource: _source, ...evidence } = answer;
            const confidence = probability(
              policy(
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
            scope.check();
            return [id, { ...evidence, confidence, confidenceSource: "custom" }];
          }),
        );
        return decode({ ...validated, answers }, questions);
      } finally {
        scope.dispose();
      }
    },
  });
}
