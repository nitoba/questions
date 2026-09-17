import { createGateway, type GatewayProviderSettings } from "@ai-sdk/gateway";
import type { QuestionModel } from "../model.ts";
import { ProviderError, ValidationError } from "../errors.ts";
import { text } from "../internal/validation.ts";
import { apiKey, baseURL, customHeaders } from "../internal/http.ts";
import type { Retry, Hooks } from "../http.ts";
import { createHttp, HttpHookError } from "../internal/http-client.ts";
import * as AISDK from "./ai-sdk.ts";

/** Official Vercel AI Gateway evaluation, with explicit authentication and bounded HTTP. */
export interface Options extends Pick<
  AISDK.Options,
  "confidence" | "providerOptions" | "timeoutMs"
> {
  readonly apiKey: string;
  /** Evaluation model ID, not a chat model. Defaults to typesafe-ai/jev. */
  readonly model?: string;
  /** Official SDK API prefix, not the /v1 OpenAI-compatible endpoint. */
  readonly baseURL?: string;
  /** Optional Vercel team scope for access tokens. */
  readonly teamIdOrSlug?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
  /** Successful response body limit in bytes, before the SDK parses JSON. Default: 1 MiB. */
  readonly maxResponseBytes?: number;
  /** HTTP retries only; disabled by default. */
  readonly retry?: Retry;
  readonly hooks?: Hooks;
}

function headerValue(value: string, path: string): string {
  try {
    new Headers({ "x-value": value });
  } catch {
    throw new ValidationError("expected a header-safe value", path);
  }
  return value;
}

/** Preserve our sanitized HTTP errors through SDK wrappers without returning sensitive bodies. */
function transportError(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof HttpHookError) return current.cause;
    if (current instanceof ProviderError || current instanceof ValidationError) return current;
    seen.add(current);
    current = current.cause;
  }
  return new ProviderError("Vercel", "response", "Vercel returned an invalid evaluation response");
}

/**
 * Create a Questions provider using the official @ai-sdk/gateway evaluation model.
 * This optional subpath does not make the AI SDK a dependency of the package root.
 * One SDK doEvaluate call per evaluation; HTTP retries are explicit and disabled by default.
 * The Gateway service may apply its own configured routing policy.
 *
 * @example
 * import * as Vercel from "@nitoba/questions/providers/vercel";
 * const questions = Questions.create({ model: Vercel.create({ apiKey }) });
 * const result = await questions.about(ticket).ask(schema);
 *
 * @example
 * // An SDK-compatible gateway/proxy uses the same protocol, not System One JSON.
 * const model = Vercel.create({ apiKey, baseURL: "https://proxy.example/v4/ai", model: "typesafe-ai/jev" });
 *
 * @throws ValidationError for configuration errors, ProviderError for sanitized transport errors.
 * Uses the experimental AI SDK Evaluation V4 contract. Keep optional peers within supported versions.
 */
export function create(options: Options): QuestionModel {
  const key = apiKey(options.apiKey);
  const modelId = headerValue(text(options.model ?? "typesafe-ai/jev", "model"), "model");
  const endpoint = baseURL(options.baseURL ?? "https://ai-gateway.vercel.sh/v4/ai");
  const headers = customHeaders(options.headers, [
    "ai-model-id",
    "ai-evaluation-model-specification-version",
    "ai-gateway-protocol-version",
    "ai-gateway-auth-method",
    "ai-gateway-team-id",
    "x-vercel-team-id",
    "x-vercel-ai-gateway-team",
  ]);
  const team =
    options.teamIdOrSlug === undefined
      ? undefined
      : headerValue(text(options.teamIdOrSlug, "teamIdOrSlug"), "teamIdOrSlug");
  const send = createHttp({ ...options, provider: "Vercel" });
  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method !== "POST" || typeof init.body !== "string")
      throw new ValidationError("expected the SDK's replayable JSON POST body", "request");
    const response = await send(
      String(input),
      { headers: new Headers(init.headers), body: init.body },
      init.signal ? { signal: init.signal } : {},
    );
    return new Response(response.content, { status: response.status, headers: response.headers });
  };
  const gateway = createGateway({
    apiKey: key,
    baseURL: endpoint.toString().replace(/\/+$/, ""),
    headers: Object.fromEntries(headers),
    // The SDK consumes the standard call signature, never Bun-specific fetch properties.
    fetch: guardedFetch as NonNullable<GatewayProviderSettings["fetch"]>,
    ...(team === undefined ? {} : { teamIdOrSlug: team }),
  });
  const official = gateway.evaluationModel(modelId);
  const model: AISDK.EvaluationModel = {
    specificationVersion: "v4",
    provider: "Vercel",
    modelId,
    supportedQuestionTypes: official.supportedQuestionTypes,
    async doEvaluate(call) {
      try {
        return await official.doEvaluate(call);
      } catch (error) {
        if (call.abortSignal?.aborted) throw call.abortSignal.reason;
        throw transportError(error);
      }
    },
  };
  return AISDK.create({
    model,
    ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
