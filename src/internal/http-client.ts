import type { Input as DurationInput } from "../duration.ts";
import { resolve as duration } from "./duration.ts";
import { createFetch } from "ofetch";
import type { Hooks, HooksList, Retry, RetryContext } from "../http.ts";
import type { RunOptions } from "../types.ts";
import { ProviderError, ValidationError } from "../errors.ts";
import { abortable, cancellation, sleep } from "./abort.ts";
import { discard, fetchResponse, readText } from "./http.ts";
import { integer } from "./validation.ts";

/** @internal Preserve callback errors through ofetch and optional SDK wrapping. */
export class HttpHookError extends Error {
  constructor(cause: unknown) {
    super("HTTP callback failed", { cause });
  }
}

interface Config {
  readonly provider: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly timeout?: DurationInput;
  readonly timeoutMs?: number;
  readonly retry?: Retry;
  readonly hooks?: Hooks;
  readonly retainNetworkCause?: boolean;
}

function delay(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    void Promise.resolve(value).catch(() => {}); // Observe illegally returned async policies.
    throw new ValidationError("expected milliseconds in [0, 2147483647]", path);
  }
  return value;
}

function retryPolicy(value: Retry | undefined): {
  readonly maxRetries: number;
  readonly statusCodes: readonly number[];
  readonly networkErrors: boolean;
  readonly jitter: boolean;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly delayMs?: number | ((context: Readonly<RetryContext>) => number);
} {
  const options =
    value === undefined || value === false
      ? { maxRetries: 0 }
      : typeof value === "number"
        ? { maxRetries: value }
        : value;
  if (!options || typeof options !== "object")
    throw new ValidationError("invalid retry policy", "retry");
  const maxRetries = integer(options.maxRetries, 0, "retry.maxRetries");
  if (maxRetries > 10)
    throw new ValidationError("at most 10 retries are allowed", "retry.maxRetries");
  const statusCodes = options.statusCodes ?? [429, 529];
  if (
    !Array.isArray(statusCodes) ||
    statusCodes.some((code) => !Number.isInteger(code) || code < 400 || code > 599)
  )
    throw new ValidationError("expected HTTP status codes in [400, 599]", "retry.statusCodes");
  const networkErrors = options.networkErrors ?? false;
  const jitter = options.jitter ?? true;
  if (typeof networkErrors !== "boolean" || typeof jitter !== "boolean")
    throw new ValidationError("networkErrors and jitter must be booleans", "retry");
  const initialDelayMs =
    duration(options.initialDelay, options.initialDelayMs, "initialDelay") ?? 200;
  const maxDelayMs = duration(options.maxDelay, options.maxDelayMs, "maxDelay", 1) ?? 30_000;
  if (options.delay !== undefined && options.delayMs !== undefined)
    throw new ValidationError("supply delay or delayMs, not both", "retry.delay");
  const configured = options.delay;
  const legacy = options.delayMs;
  const convert = (value: DurationInput) => duration(value, undefined, "delay")!;
  const delayMs =
    typeof configured === "function"
      ? (event: Readonly<RetryContext>) => {
          const value = configured(event);
          void Promise.resolve(value).catch(() => {});
          return convert(value);
        }
      : configured !== undefined
        ? convert(configured)
        : legacy;
  if (delayMs !== undefined && typeof delayMs !== "function") delay(delayMs, "retry.delayMs");
  return Object.freeze({
    maxRetries,
    statusCodes: Object.freeze([...new Set(statusCodes)]),
    networkErrors,
    jitter,
    initialDelayMs,
    maxDelayMs,
    ...(delayMs === undefined ? {} : { delayMs }),
  });
}

function hookList<T>(hooks: HooksList<T> | undefined, name: string) {
  const list = hooks === undefined ? [] : Array.isArray(hooks) ? [...hooks] : [hooks];
  if (list.some((hook) => typeof hook !== "function"))
    throw new ValidationError("expected a function or array of functions", `hooks.${name}`);
  return Object.freeze(list) as readonly ((context: Readonly<T>) => unknown)[];
}

function retryAfter(response: Response | undefined): number | undefined {
  const value = response?.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  // Overflow means an unreasonably long wait, not permission to ignore the server's instruction.
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function safeError(error: ProviderError): ProviderError {
  return Object.freeze(
    new ProviderError(
      error.provider,
      error.kind,
      error.message,
      error.status === undefined ? {} : { status: error.status },
    ),
  );
}

/**
 * @internal ofetch owns HTTP dispatch and attempt counting; async hooks implement cancellable
 * backoff and safe response disposal. Stream mode avoids permissive/unbounded JSON parsing.
 * No ofetch context, FetchError, request body or authentication escapes this boundary.
 */
export function createHttp(config: Config) {
  const provider = config.provider;
  const retainNetworkCause = config.retainNetworkCause === true;
  const policy = retryPolicy(config.retry);
  const hooks = {
    onRequest: hookList(config.hooks?.onRequest, "onRequest"),
    onResponse: hookList(config.hooks?.onResponse, "onResponse"),
    onRetry: hookList(config.hooks?.onRetry, "onRetry"),
    onError: hookList(config.hooks?.onError, "onError"),
  };
  const limit = integer(config.maxResponseBytes ?? 1_048_576, 1, "maxResponseBytes");
  const timeoutMs = duration(config.timeout, config.timeoutMs, "timeout", 1);
  cancellation(undefined, timeoutMs).dispose();
  const fetcher = config.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new ValidationError("fetch is unavailable", "fetch");
  const http = createFetch({
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? new AbortController().signal;
      // Fresh transport inputs isolate ofetch's retry state from injected fetch mutation.
      return fetchResponse(
        fetcher,
        new URL(String(input)),
        { ...init, headers: new Headers(init?.headers) },
        signal,
      );
    }) as typeof globalThis.fetch,
  });
  return async (
    url: string,
    init: { readonly headers: Headers; readonly body: string },
    run: RunOptions = {},
  ) => {
    const scope = cancellation(run.signal, timeoutMs);
    const signal = scope.signal;
    const started = performance.now();
    let attempt = 0;
    let failure: ProviderError | undefined;
    const context = () =>
      Object.freeze({ provider, attempt, elapsedMs: performance.now() - started, signal });
    async function emit<T>(list: readonly ((event: Readonly<T>) => unknown)[], event: T) {
      for (const hook of list) {
        signal.throwIfAborted();
        try {
          await abortable(hook(Object.freeze(event)), signal);
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          throw new HttpHookError(cause);
        }
      }
      signal.throwIfAborted();
    }
    async function beforeRetry(
      options: { retry?: number | boolean },
      error: ProviderError,
      response?: Response,
    ) {
      failure = error;
      discard(response?.body ?? null);
      signal.throwIfAborted();
      const eligible =
        options.retry !== false &&
        (response ? policy.statusCodes.includes(response.status) : policy.networkErrors);
      const requested = retryAfter(response);
      if (
        !eligible ||
        attempt > policy.maxRetries ||
        (requested !== undefined && requested > policy.maxDelayMs)
      ) {
        options.retry = false;
        return;
      }
      const event: RetryContext = Object.freeze({
        ...context(),
        error: safeError(error),
        nextAttempt: attempt + 1,
        ...(requested === undefined ? {} : { retryAfterMs: requested }),
      });
      let wait: number;
      if (typeof policy.delayMs === "function") {
        try {
          wait = policy.delayMs(event);
        } catch (cause) {
          throw new HttpHookError(cause);
        }
      } else if (policy.delayMs !== undefined) wait = policy.delayMs;
      else {
        const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
        wait = policy.jitter ? Math.random() * exponential : exponential;
      }
      delay(wait, "retry.delayMs");
      wait = Math.max(wait, requested ?? 0);
      if (wait > policy.maxDelayMs) {
        options.retry = false;
        return;
      }
      await emit(hooks.onRetry, { ...event, delayMs: wait });
      // ofetch's own retryDelay is not abort-aware. Keep it zero and await our cancellable delay.
      if (wait > 0) await sleep(wait, signal);
    }
    try {
      signal.throwIfAborted();
      const response = await abortable(
        http.raw(url, {
          method: "POST",
          body: init.body,
          headers: new Headers(init.headers),
          signal,
          responseType: "stream",
          redirect: "error",
          retry: policy.maxRetries,
          retryDelay: 0,
          retryStatusCodes: [...policy.statusCodes, ...(policy.networkErrors ? [500] : [])],
          onRequest: async () => {
            attempt++;
            await emit(hooks.onRequest, context());
          },
          onRequestError: async ({ options, error }) => {
            if (error?.name === "AbortError") options.retry = false;
            await beforeRetry(
              options,
              new ProviderError(
                provider,
                "network",
                `Unable to reach ${provider}`,
                retainNetworkCause ? { cause: error } : {},
              ),
            );
          },
          onResponse: async ({ response }) => {
            // Dispose failure bodies before calling user hooks; they can throw or stall.
            if (!response.ok) discard(response.body);
            try {
              await emit(hooks.onResponse, { ...context(), status: response.status });
            } catch (error) {
              discard(response.body);
              throw error;
            }
          },
          onResponseError: async ({ options, response }) =>
            beforeRetry(
              options,
              new ProviderError(provider, "http", `${provider} returned HTTP ${response.status}`, {
                status: response.status,
              }),
              response,
            ),
        }),
        signal,
      );
      if (!response.ok) {
        discard(response.body);
        throw new ProviderError(provider, "http", `${provider} returned HTTP ${response.status}`, {
          status: response.status,
        });
      }
      const content = await readText(response, limit, signal, provider);
      signal.throwIfAborted();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return { content, status: response.status, headers };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpHookError || error instanceof ValidationError) throw error;
      const primary =
        error instanceof ProviderError
          ? error
          : (failure ?? new ProviderError(provider, "network", `Unable to reach ${provider}`));
      await emit(hooks.onError, { ...context(), error: safeError(primary) });
      throw primary;
    } finally {
      scope.dispose();
    }
  };
}
