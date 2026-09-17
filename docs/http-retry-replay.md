# HTTP, retries and replay

The native TypeSafe/System One providers and the optional Vercel provider share an **ofetch 1.5.0** HTTP client. The dependency is pinned to v1; the upstream `main` branch currently describes v2 alpha. Questions uses ofetch's real request/retry lifecycle, not a second independent retry loop. The SDK bridge for an externally supplied model remains transport-neutral and does not import ofetch.

## Retry: explicitly repeat a failed HTTP attempt

```ts
import { Questions, TypeSafe } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");

const questions = Questions.create({
  model: TypeSafe.create({
    apiKey,
    timeoutMs: 15_000,
    retry: {
      maxRetries: 2,
      statusCodes: [429, 503, 529],
      initialDelayMs: 250,
      maxDelayMs: 3_000,
      jitter: true,
    },
  }),
});
```

The same `retry` and `hooks` options work with `Jev.create`, `SystemOne.create` and `Vercel.create`. Vercel still calls the official SDK evaluation method once; ofetch may make extra **HTTP attempts inside that call**. The generic `AISDK.create` cannot control a transport owned by another SDK instance; configure that instance's transport explicitly. Questions never wraps arbitrary SDK errors in an additional retry loop.

| Configuration                                  | Meaning                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| omitted, `false`, `0`                          | One attempt, no automatic retry                                      |
| `retry: 2`                                     | Up to two additional attempts for HTTP 429/529                       |
| `retry: { maxRetries: 2, statusCodes: [503] }` | Retry only the selected HTTP status                                  |
| `networkErrors: true`                          | Also retry native fetch failures; disabled by default                |
| `delayMs: 500`                                 | Fixed delay instead of exponential/jitter backoff                    |
| `delayMs: ({ attempt }) => attempt * 500`      | Synchronous custom delay; `attempt` is the failed, one-based attempt |

`maxRetries` is in `[0, 10]`. Default statuses remain `[429, 529]`, preserving the alpha.3 TypeSafe policy rather than silently adopting ofetch's broader defaults. Default backoff starts at 200ms, uses full jitter, and is capped at 30 seconds. Arrays and policy settings are snapshotted at provider creation.

**Retry-After is a lower bound**, including when using a custom delay. Seconds and HTTP dates are supported. If the server's required wait or an explicit delay exceeds `maxDelayMs`, the operation returns the current HTTP/network error instead of retrying earlier. A callback must return a finite, nonnegative number within the platform timer limit; a promise is not a valid delay policy. Invalid results stop without a new request. Throwing callbacks preserve the thrown value.

`timeoutMs` is one total provider budget, not a fresh budget for every attempt. It includes hooks, fetch, response reading and backoff. Cancellation during backoff prevents the next dispatch. ofetch's built-in delay is kept at zero; its asynchronous lifecycle hooks await our abort-aware delay, because ofetch v1's default timer cannot be canceled. The outer cancellation scope also avoids v1's limitation around combining its own timeout with an existing signal.

Requests use stable JSON bytes and fresh per-attempt headers/URL objects. Business handlers, Zod transforms, parsing errors, invalid evidence, confidence rejections and schema failures are **never automatically retried**. A successful HTTP response with a failing body read is not retried either: upstream may already have completed the inference. A custom fetch's own retries or Gateway service-side routing/fallback can add work outside this client's attempt count.

**POST retries can duplicate work and billing.** Even a network error does not establish that the server never accepted the request. `networkErrors: true` is a separate opt-in for that reason. There is no idempotency guarantee, compensating transaction, or implicit replay of application actions. Headers do not create idempotency support where a provider does not implement it.

## Lifecycle hooks

```ts
const model = TypeSafe.create({
  apiKey,
  retry: { maxRetries: 2, delayMs: 250 },
  hooks: {
    onRequest: [
      ({ provider, attempt }) => console.log("HTTP attempt", provider, attempt),
      async ({ signal }) => {
        signal.throwIfAborted();
        // An application's asynchronous tracing hook may go here.
      },
    ],
    onResponse: ({ status, elapsedMs }) => console.log("HTTP headers", status, elapsedMs),
    onRetry: ({ nextAttempt, delayMs }) => console.log("Retry scheduled", nextAttempt, delayMs),
    onError: ({ error, attempt }) => console.error("HTTP failed", error.kind, attempt),
  },
});
```

Hooks accept one function or an ordered array. Arrays are snapshotted, functions are awaited sequentially, and every event includes `provider`, `attempt`, `elapsedMs`, and `signal`. Each concurrent HTTP operation has independent counters; attempts are not a global counter or a stable correlation ID.

`onResponse` means response **headers arrived**, not that body reading, JSON, evidence or Zod validation succeeded. `onRetry` runs before the delay; a hook failure or cancellation can still prevent the next attempt. `onError` runs once for a terminal HTTP/network/body-read failure, not for every failed attempt. It does not observe schema/protocol errors occurring after transport, user hook errors or cancellation. Use application-level `try/catch` for the whole semantic operation.

Events are frozen and contain **no URL, prompt, body, API key, headers, raw Response or ofetch context**. Error copies supplied to callbacks have no transport cause. Native System One failures still retain the original custom fetch cause on the thrown ProviderError for compatibility; do not log that cause indiscriminately. No raw ofetch FetchError (which can retain request data) is exposed. The Vercel preset keeps its stricter sanitized errors.

A throwing hook stops the call and its original error is propagated, including through the Vercel SDK wrapper. It is never automatically retried. An `onError` hook that throws replaces the primary error; keep telemetry hooks nonthrowing to preserve the transport failure. Async hooks that ignore cancellation can continue locally, but cannot trigger a later library HTTP dispatch after the signal has aborted. Avoid side effects in tracing hooks, which run per attempt rather than per application operation.

## Replay: a new inference using the original inputs

`ask` remains the value-only API. Use `run` to get a value, evidence and explicit replay:

```ts
import { z } from "zod";

const schema = z.object({
  urgent: z.boolean().describe("Does this incident prevent production work?"),
  team: z.enum(["billing", "platform"]).describe("Which team should investigate?"),
});

const first = await questions.about("The production API returns 503").run(schema, {
  signal: AbortSignal.timeout(15_000),
});
console.log(first.value); // z.output<typeof schema>
console.log(first.evidence?.usage);

const second = await first.replay({
  signal: AbortSignal.timeout(15_000),
});
console.log(second.value);
```

Each `replay()` makes a fresh inference, using the **same snapshotted context and normalized questions**, and validates the new result. It is not a cached response, token replay, or deterministic promise of the same output. Re-awaiting `first` does not cause a replay. Retaining multiple Execution objects is an application decision, not an unbounded library buffer.

The previous model and call-level confidence policy are inherited unless explicitly overridden; **the previous AbortSignal is never inherited**. Each call has its own lifecycle. Static nested JSON, question descriptions and schema annotations are captured. Live context is resolved only once for a particular prepared request, not on every replay. Call `q.run(schema)` or `q.ask(schema)` again to read live context again.

An Execution's outer object and evidence are frozen; `value` follows the supplied Zod schema's mutability rules. `evidence` is undefined for constant-only schemas, which need no inference. Plain question batches retain literal-key types in both `value` and `evidence`.

### Prepare before inference, including recovery after a failure

```ts
const prepared = await questions.about(() => ({ currentIncident })).prepare(schema);
// Context has now been captured. No provider request or Zod parse callback ran.
console.log(prepared.request?.questions); // Inspect normalized questions; IDs may be opaque.

const result = await prepared.run({ signal: AbortSignal.timeout(15_000) });
// A later prepared.run() starts another evaluation even if the first run threw.
```

`prepare` validates schemas/questions and confidence before resolving context. Its signal covers **preparation only**. Unsupported schemas fail without reading live context. Constant-only schemas skip context too. The prepared request exposes sensitive application data intentionally; it is not appropriate for indiscriminate telemetry or public logs.

`prepared.run()` uses the preparation's default provider/confidence unless overridden. `result.replay()` instead inherits that particular result's effective provider/confidence, so concurrent comparisons do not mutate one another's defaults.

### Compare providers explicitly

```ts
import * as Vercel from "@nitoba/questions/providers/vercel";

const gatewayKey = process.env.AI_GATEWAY_API_KEY;
if (!gatewayKey) throw new Error("Set AI_GATEWAY_API_KEY");

const viaGateway = await first.replay({
  model: Vercel.create({ apiKey: gatewayKey, timeoutMs: 15_000 }),
});
```

This deliberately sends the captured data to another service. No automatic fallback occurs. Different protocols may use different confidence metrics; consult [providers](providers.md) before carrying thresholds across services.

Replay does not capture branch handlers or downstream stream callbacks. However, **Zod refinements and transforms run again once per replay**. Closures and external state used by those callbacks cannot be snapshotted. Keep them pure where practical; side effects in a transform are repeated application code, not a transaction. This API is in-memory only: it does not serialize closures, schemas, credentials or crash-recovery state.

### Compose with Web Streams

```ts
const stream = Streams.from(tickets)
  .map((ticket, { signal }) => questions.about(ticket).run(schema, { signal }), {
    concurrency: 4,
  })
  .toReadable(); // ReadableStream<Execution<z.output<typeof schema>>>
```

This retains existing lazy execution, backpressure and cancellation. It does not add a retry operator to a whole stream: restarting a partially consumed stream could duplicate downstream effects. A single item can be replayed explicitly, with its own signal.

## Which ofetch features map to Questions?

### Implemented in alpha.4

The real ofetch retry lifecycle now supports configurable status codes and explicit network retry across the native and Vercel providers. Async interceptor arrays inspired the credential-safe HTTP hooks. `raw` and stream responses let Questions preserve bounded byte reading and native readers; its strict JSON and evidence validators remain authoritative. The distinction between value-only and detailed results inspired `q.run(...).value/evidence/replay` and `q.prepare(...)`.

### Useful next steps, not implemented in this release

| Priority | Inspiration                 | Questions feature and concrete value                                                                                                                                                                                                 | Required contract                                                                                                                          |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| High     | Lifecycle interceptors      | Provider-neutral `onEvaluate` / `onDecision` hooks for one complete semantic operation: measure inference, schema parsing, confidence rejection and reported usage without counting every HTTP attempt as a new application decision | Typed, read-only events; distinguish network attempts, inference and parsing; no credentials/prompts by default                            |
| High     | `ofetch.create(defaults)`   | Immutable client defaults and derived clients, such as a support client with a confidence gate and a total operation deadline, avoiding repeated call options                                                                        | Explicit precedence; no shared mutable nested defaults; operation budget includes live context and Zod; schema minimums cannot be weakened |
| Medium   | `.raw()`                    | Path-aware diagnostics joining schema field paths with their generated question IDs, evidence and annotations, making a rejected nested field understandable without reverse-engineering `q0` identifiers                            | Reuse the compiled plan; no second inference and no generated explanations presented as evidence                                           |
| Medium   | Explicit request recreation | An opt-in record/offline-replay adapter for reproducible tests and evaluation datasets, distinct from the live replay added here                                                                                                     | Versioned schema/provider identity, bounded storage, redaction, strict matching and revalidation; no silent live-network fallback          |

These are focused extensions of existing flows, not new implementations in this release. In particular, offline replay would be a different API from `Execution.replay()` and must never quietly turn a test into a paid request.

### Features deliberately not copied wholesale

Arbitrary ofetch `FetchOptions` would expose a way to bypass body limits, parsing, cancellation, redirects and retry budgets, so public configuration remains narrower. Transport injection still accepts standard `fetch`; proxy agents or platform-specific networking can be configured there without importing Node/Bun APIs into the core. Query-string helpers and binary request bodies do not improve the current finite-decision POST protocol. A generic `ofetch<T>` annotation is not runtime validation and cannot replace Zod. SSE support in an HTTP client does not mean the provider offers token streaming. No insecure TLS shortcuts or automatic auth-refresh replay are introduced.

## Verification and references

The suite exercises the installed ofetch and official Gateway packages, JSON replay bytes, per-attempt isolation, configured statuses, network opt-in, cancellation/backoff, Retry-After, throwing/async hooks, reader cleanup, replay snapshots and callback counts. Installed-tarball tests run with real dependencies both with and without the Gateway SDK. Streams and the structural SDK bridge are tested after removing ofetch and Zod from a consumer. Tests make no paid inference calls.

Sources inspected September 17, 2026:

- [ofetch v1 README](https://github.com/unjs/ofetch/tree/v1)
- [ofetch v1 request, retry and hook implementation](https://github.com/unjs/ofetch/blob/v1/src/fetch.ts)
- [ofetch package and exports](https://github.com/unjs/ofetch/blob/v1/package.json)
- [ofetch main: v2 alpha](https://github.com/unjs/ofetch)
