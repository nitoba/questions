import { ProviderError, ValidationError } from "../errors.ts";
import { abortable } from "./abort.ts";
import { text } from "./validation.ts";

/** @internal URL prefixes may contain paths, but never credentials, queries or fragments. */
export function baseURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(text(value, "baseURL"));
  } catch {
    throw new ValidationError("expected an absolute HTTP(S) URL", "baseURL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ValidationError("expected HTTP(S) without credentials, query or fragment", "baseURL");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** @internal Snapshot custom headers and prevent protocol/credential overrides. */
export function customHeaders(
  value: HeadersInit | undefined,
  reserved: readonly string[] = [],
): Headers {
  let headers: Headers;
  try {
    headers = new Headers(value);
  } catch {
    throw new ValidationError("invalid HTTP headers", "headers");
  }
  for (const key of headers.keys()) {
    if (["authorization", "content-type", "content-length", "host", ...reserved].includes(key))
      throw new ValidationError(`header ${key} is managed by the provider`, "headers");
  }
  return headers;
}

/** @internal Bearer tokens must be header-safe; errors never interpolate the secret. */
export function apiKey(value: string): string {
  const key = text(value, "apiKey");
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new ValidationError(
      "expected a nonempty, printable ASCII bearer token without whitespace",
      "apiKey",
    );
  return key;
}

/** @internal Cancel cleanup cannot delay the primary result on an uncooperative source. */
export function discard(body: ReadableStream<Uint8Array> | null, reason?: unknown): void {
  if (body) void body.cancel(reason).catch(() => {});
}

/** @internal Follow no redirects; cancel a response which arrives after cancellation. */
export async function fetchResponse(
  fetcher: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  return abortable(
    Promise.resolve(fetcher(input, { ...init, signal, redirect: "error" })).then((response) => {
      if (signal.aborted) {
        discard(response.body, signal.reason);
        signal.throwIfAborted();
      }
      return response;
    }),
    signal,
  );
}

/** @internal Read bounded UTF-8, preserving bytes even when multibyte characters span chunks. */
export async function readText(
  response: Response,
  limit: number,
  signal: AbortSignal,
  provider: string,
): Promise<string> {
  if (!response.body)
    throw new ProviderError(provider, "response", `${provider} returned an empty body`);
  const reader = response.body.getReader();
  let bytes = 0;
  let content = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > limit)
      throw new ProviderError(
        provider,
        "response",
        `${provider} response exceeds maxResponseBytes`,
      );
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit)
        throw new ProviderError(
          provider,
          "response",
          `${provider} response exceeds maxResponseBytes`,
        );
      content += decoder.decode(next.value, { stream: true });
    }
    return content + decoder.decode();
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderError(provider, "response", `${provider} returned unreadable UTF-8`, {
      cause,
    });
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
