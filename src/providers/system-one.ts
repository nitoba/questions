import type { Input as DurationInput } from "../duration.ts";
import type { EvaluationRequest, QuestionModel } from "../model.ts";
import type { RunOptions } from "../types.ts";
import type { Retry, Hooks } from "../http.ts";
import { ProviderError, ValidationError } from "../errors.ts";
import { integer, text } from "../internal/validation.ts";
import { apiKey as validateKey, baseURL, customHeaders } from "../internal/http.ts";
import { createHttp, HttpHookError } from "../internal/http-client.ts";
import { requestBody, normalizeResponse } from "../internal/system-one.ts";

export type { RetryOptions } from "../http.ts";
/** An HTTP endpoint implementing System One, not OpenAI Chat Completions or the AI SDK protocol. */
export interface Options {
  /** API prefix, including any /v1 or proxy path. The relative path is appended, never replaced. */
  readonly baseURL: string;
  /** Explicit identifier understood by this endpoint. No model is guessed. */
  readonly model: string;
  /** Omit only for a trusted unauthenticated endpoint. No environment variables are read. */
  readonly apiKey?: string;
  /** Error/diagnostic label, not the model ID. Defaults to SystemOne. */
  readonly name?: string;
  /** Relative endpoint path. Defaults to systemone. Absolute URLs and traversal are rejected. */
  readonly path?: string;
  /** Extra headers, snapshotted at construction. Managed protocol/auth headers cannot be replaced. */
  readonly headers?: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
  /** Entire evaluation budget, including body reads and backoff. No timeout by default. */
  readonly timeout?: DurationInput;
  /** @deprecated Use timeout, which also accepts a human-readable duration. */
  readonly timeoutMs?: number;
  readonly retry?: Retry;
  /** Read-only, credential-safe HTTP lifecycle hooks. */
  readonly hooks?: Hooks;
  /** Bound successful response bytes. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Provider criteria ceiling; defaults to 255. It is not a client-side batching limit. */
  readonly maxCriteria?: number;
}

/**
 * Connect a System One-compatible host with ordinary fetch and no provider SDK dependency.
 * The host must accept state/model/questions with noul, choice and score answers.
 * Merely changing baseURL cannot adapt a different wire protocol.
 * @example
 * const model = SystemOne.create({
 *   baseURL: "https://inference.example.com/v1", apiKey,
 *   model: "hosted-jev", headers: { "x-project-id": "support" },
 * });
 * const questions = Questions.create({ model });
 * @throws ValidationError before I/O for invalid configuration.
 */
export function create(options: Options): QuestionModel {
  const key = options.apiKey === undefined ? undefined : validateKey(options.apiKey);
  const model = text(options.model, "model");
  const name = text(options.name ?? "SystemOne", "name");
  const endpoint = baseURL(options.baseURL);
  const path = options.path ?? "systemone";
  if (typeof path !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path))
    throw new ValidationError(
      "expected a relative endpoint path without traversal, query or fragment",
      "path",
    );
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${path}`;
  const headers = customHeaders(options.headers);
  if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  const maxCriteria = integer(options.maxCriteria ?? 255, 2, "maxCriteria");
  const send = createHttp({ ...options, provider: name, retainNetworkCause: true });
  return Object.freeze({
    name,
    async evaluate(request: EvaluationRequest, run: RunOptions = {}): Promise<unknown> {
      run.signal?.throwIfAborted();
      const body = requestBody(request, model, maxCriteria);
      try {
        const { content } = await send(endpoint.toString(), { body, headers }, run);
        let value: unknown;
        try {
          value = JSON.parse(content);
        } catch {
          throw new ProviderError(name, "response", `${name} returned invalid JSON`);
        }
        run.signal?.throwIfAborted();
        return normalizeResponse(value);
      } catch (error) {
        if (error instanceof HttpHookError) throw error.cause;
        throw error;
      }
    },
  });
}
