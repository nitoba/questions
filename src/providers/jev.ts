import { ProviderError, ValidationError } from "../errors.ts";
import type { EvaluationRequest, QuestionModel } from "../model.ts";
import type { Description, RunOptions } from "../types.ts";
import { abortable, cancellation, sleep } from "../internal/abort.ts";
import { integer, record, text } from "../internal/validation.ts";
import { normalize } from "../question.ts";
import { state as validateState } from "../internal/validation.ts";

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
/** Jev transport configuration. The secret stays inside a closure, never on the returned model. */
export interface Options {
  readonly apiKey: string;
  readonly model?: string;
  /** Base URL including /v1, without query parameters or credentials. */
  readonly baseUrl?: string;
  /** Fetch injection supports tracing, custom transports and contract tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Total evaluation budget, including response reading and retry delays. No default timeout. */
  readonly timeoutMs?: number;
  readonly retry?: RetryOptions;
  /** Bound successful JSON response bytes. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
}

function describe(value: Description): string | null {
  return value === null || typeof value === "string" ? value : JSON.stringify(value);
}

function requestBody(request: EvaluationRequest, model: string): string {
  const questions = normalize(request.questions);
  const wire = Object.fromEntries(
    Object.entries(questions).map(([key, question]) => {
      if (question.type !== "boolean" && Object.keys(question.criteria).length > 255) {
        throw new ValidationError("Jev supports at most 255 criteria", `questions.${key}.criteria`);
      }
      switch (question.type) {
        case "boolean":
          return [
            key,
            {
              type: "noul",
              instructions: question.instructions,
              ...(question.criteria === undefined
                ? {}
                : {
                    criteria: {
                      true: describe(question.criteria.true),
                      false: describe(question.criteria.false),
                    },
                  }),
            },
          ];
        case "choice":
          return [
            key,
            {
              ...question,
              criteria: Object.fromEntries(
                Object.entries(question.criteria).map(([id, value]) => [id, describe(value)]),
              ),
            },
          ];
        case "score":
          return [key, question];
      }
    }),
  );
  return JSON.stringify({ state: validateState(request.state), model, questions: wire });
}

async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ProviderError("Jev", "response", "Jev returned an empty body");
  const reader = response.body.getReader();
  let bytes = 0;
  let content = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > limit) {
      throw new ProviderError("Jev", "response", "Jev response exceeds maxResponseBytes");
    }
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit)
        throw new ProviderError("Jev", "response", "Jev response exceeds maxResponseBytes");
      content += decoder.decode(next.value, { stream: true });
    }
    content += decoder.decode();
    return JSON.parse(content) as unknown;
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderError("Jev", "response", "Jev returned invalid JSON or UTF-8", { cause });
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Preserve primary failure. */
    }
    reader.releaseLock();
  }
}

/** Convert only the provider protocol. The Questions client performs full semantic validation. */
function normalizeResponse(value: unknown): unknown {
  const response = record(value, "response");
  const usage = record(response.usage, "response.usage");
  const answers = record(response.answers, "response.answers");
  return {
    model: response.model,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, raw]) => {
        const answer = record(raw, `response.answers.${key}`);
        return [
          key,
          answer.type === "noul" ? { type: "boolean", probability: answer.noul } : answer,
        ];
      }),
    ),
  };
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
 * Create a Jev model using the documented POST /v1/systemone JSON endpoint.
 * Does not invent token streaming. Compose Streams.map for incremental item processing.
 *
 * @example
 * const model = Jev.create({ apiKey: process.env.TYPESAFE_API_KEY!, timeoutMs: 15_000 });
 * const client = Questions.create({ model });
 *
 * @example
 * // Opt into extra paid attempts deliberately, at the HTTP boundary only.
 * const model = Jev.create({ apiKey, retry: { maxRetries: 2 }, fetch: tracedFetch });
 *
 * @throws ValidationError for invalid configuration, before any network request.
 */
export function create(options: Options): QuestionModel {
  const apiKey = text(options.apiKey, "apiKey");
  const model = text(options.model ?? "jev-latest", "model");
  const endpoint = new URL(options.baseUrl ?? "https://api.typesafe.ai/v1");
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new ValidationError(
      "baseUrl must be an HTTP(S) URL without credentials, query or fragment",
      "baseUrl",
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/systemone`;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new ValidationError("fetch is unavailable", "fetch");
  const maxResponseBytes = integer(options.maxResponseBytes ?? 1_048_576, 1, "maxResponseBytes");
  const maxRetries = integer(options.retry?.maxRetries ?? 0, 0, "retry.maxRetries");
  if (maxRetries > 10)
    throw new ValidationError("at most 10 retries are allowed", "retry.maxRetries");
  const initialDelay = integer(options.retry?.initialDelayMs ?? 200, 0, "retry.initialDelayMs");
  const maxDelay = integer(options.retry?.maxDelayMs ?? 30_000, 1, "retry.maxDelayMs");
  if (maxDelay > 2_147_483_647)
    throw new ValidationError("delay exceeds platform timer limit", "retry.maxDelayMs");
  // Validate the timeout now rather than after the first attempted evaluation.
  const checked = cancellation(undefined, options.timeoutMs);
  checked.dispose();
  const timeoutMs = options.timeoutMs;
  const jitter = options.retry?.jitter ?? true;

  return Object.freeze({
    name: "Jev",
    async evaluate(request: EvaluationRequest, run: RunOptions = {}): Promise<unknown> {
      run.signal?.throwIfAborted();
      const body = requestBody(request, model); // Stable, replayable bytes for this evaluation only.
      const scope = cancellation(run.signal, timeoutMs);
      try {
        for (let attempt = 0; ; attempt++) {
          scope.signal.throwIfAborted();
          let response: Response;
          try {
            const pending = fetcher(new URL(endpoint), {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body,
              signal: scope.signal,
              redirect: "error",
            });
            response = await abortable(
              Promise.resolve(pending).then((value) => {
                if (scope.signal.aborted) {
                  void value.body?.cancel(scope.signal.reason).catch(() => {});
                  scope.signal.throwIfAborted();
                }
                return value;
              }),
              scope.signal,
            );
          } catch (cause) {
            if (scope.signal.aborted) throw scope.signal.reason;
            throw new ProviderError("Jev", "network", "Unable to reach Jev", { cause });
          }
          if (response.ok)
            return normalizeResponse(await readJson(response, maxResponseBytes, scope.signal));
          const error = new ProviderError("Jev", "http", `Jev returned HTTP ${response.status}`, {
            status: response.status,
          });
          const requestedDelay = retryAfter(response);
          try {
            await response.body?.cancel();
          } catch {
            /* Preserve status error. */
          }
          if (
            ![429, 529].includes(response.status) ||
            attempt >= maxRetries ||
            (requestedDelay !== undefined && requestedDelay > maxDelay)
          )
            throw error;
          const exponential = Math.min(maxDelay, initialDelay * 2 ** attempt);
          const backoff = jitter ? Math.random() * exponential : exponential;
          await sleep(Math.max(backoff, requestedDelay ?? 0), scope.signal);
        }
      } finally {
        scope.dispose();
      }
    },
  });
}
