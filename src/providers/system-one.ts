import type { EvaluationRequest, QuestionModel } from "../model.ts";
import type { RunOptions } from "../types.ts";
import { ProviderError, ValidationError } from "../errors.ts";
import { cancellation, sleep } from "../internal/abort.ts";
import { integer, text } from "../internal/validation.ts";
import {
  apiKey as validateKey,
  baseURL,
  customHeaders,
  discard,
  fetchResponse,
  readText,
} from "../internal/http.ts";
import { requestBody, normalizeResponse } from "../internal/system-one.ts";

/** Explicit retry policy for HTTP 429/529 only. No retries are made unless configured. */
export interface RetryOptions {
  /** Additional attempts, in [0, 10]. */
  readonly maxRetries: number;
  /** Initial exponential delay. Defaults to 200ms. */
  readonly initialDelayMs?: number;
  /** Maximum wait. A larger Retry-After stops retries rather than retrying too early. Defaults to 30s. */
  readonly maxDelayMs?: number;
  /** Add full jitter to exponential backoff. Defaults to true. Retry-After is never shortened. */
  readonly jitter?: boolean;
}
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
  readonly timeoutMs?: number;
  readonly retry?: RetryOptions;
  /** Bound successful response bytes. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Provider criteria ceiling; defaults to 255. It is not a client-side batching limit. */
  readonly maxCriteria?: number;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
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
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new ValidationError("fetch is unavailable", "fetch");
  const limit = integer(options.maxResponseBytes ?? 1_048_576, 1, "maxResponseBytes");
  const maxCriteria = integer(options.maxCriteria ?? 255, 2, "maxCriteria");
  const maxRetries = integer(options.retry?.maxRetries ?? 0, 0, "retry.maxRetries");
  if (maxRetries > 10)
    throw new ValidationError("at most 10 retries are allowed", "retry.maxRetries");
  const initialDelay = integer(options.retry?.initialDelayMs ?? 200, 0, "retry.initialDelayMs");
  const maxDelay = integer(options.retry?.maxDelayMs ?? 30_000, 1, "retry.maxDelayMs");
  if (maxDelay > 2_147_483_647)
    throw new ValidationError("delay exceeds platform timer limit", "retry.maxDelayMs");
  const checked = cancellation(undefined, options.timeoutMs);
  checked.dispose();
  const timeoutMs = options.timeoutMs;
  const jitter = options.retry?.jitter ?? true;
  if (typeof jitter !== "boolean") throw new ValidationError("expected boolean", "retry.jitter");
  return Object.freeze({
    name,
    async evaluate(request: EvaluationRequest, run: RunOptions = {}): Promise<unknown> {
      run.signal?.throwIfAborted();
      const body = requestBody(request, model, maxCriteria);
      const scope = cancellation(run.signal, timeoutMs);
      try {
        for (let attempt = 0; ; attempt++) {
          let response: Response;
          try {
            response = await fetchResponse(
              fetcher,
              new URL(endpoint),
              {
                method: "POST",
                headers: new Headers(headers),
                body,
              },
              scope.signal,
            );
          } catch (cause) {
            if (scope.signal.aborted) throw scope.signal.reason;
            throw new ProviderError(name, "network", `Unable to reach ${name}`, { cause });
          }
          if (response.ok) {
            const content = await readText(response, limit, scope.signal, name);
            let value: unknown;
            try {
              value = JSON.parse(content);
            } catch {
              throw new ProviderError(name, "response", `${name} returned invalid JSON`);
            }
            scope.signal.throwIfAborted();
            return normalizeResponse(value);
          }
          const error = new ProviderError(
            name,
            "http",
            `${name} returned HTTP ${response.status}`,
            { status: response.status },
          );
          const requestedDelay = retryAfter(response);
          discard(response.body);
          if (
            ![429, 529].includes(response.status) ||
            attempt >= maxRetries ||
            (requestedDelay !== undefined && requestedDelay > maxDelay)
          )
            throw error;
          const exponential = Math.min(maxDelay, initialDelay * 2 ** attempt);
          await sleep(
            Math.max(jitter ? Math.random() * exponential : exponential, requestedDelay ?? 0),
            scope.signal,
          );
        }
      } finally {
        scope.dispose();
      }
    },
  });
}
