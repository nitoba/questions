# Working on Questions

- Keep the runtime provider-neutral. Zod 4 is a peer dependency; import only zod/v4/core for schema integration. Keep the streams and provider subpaths independent of Zod. Do not import Effect, Node, or Bun in src.
- Preserve schema output inference. Validate provider evidence before Zod refinements/transforms; unsupported schemas fail before inference. Never treat Zod as an unsafe result cast.
- Use Bun 1.4.2, TypeScript 7, Oxlint, Oxfmt and tsdown. Run `bun run check` before delivery.
- New public functions and overloads require JSDoc, runtime tests, and type-contract tests where inference matters.
- Keep a raw Web Streams escape hatch. Do not add fibers, a scheduler runtime, or pretend Promises carry typed error channels.
- Streams are lazy descriptions. Every consumption is a new execution except explicitly single-use inputs. Do not retry, cache, replay or tee implicitly.
- Cancellation must close readers, remove listeners, and propagate AbortSignal to cooperative callbacks and fetch. Never promise to forcibly stop arbitrary Promises.
- Preserve bounded concurrency, input-order defaults, and no unbounded background buffering.
- Provider responses are untrusted. Validate keys, ranges, probability mass and finite numbers before executing application callbacks.
- API keys must not appear in source, logs or examples. Live tests are opt-in and may incur provider charges.
- Do not publish to npm without explicit authorization.
- Keep optional Gateway imports confined to the Vercel subpath. Test both native consumers without the SDK and consumers with the real SDK installed.
- Never guess distributions, missing token counts, or TypeSafe confidence from another protocol. Preserve provenance and reported precision; see docs/providers.md.
- Owned HTTP transports use pinned ofetch through internal/http-client.ts. Keep total budgets, abort-aware backoff and byte limits; never expose raw FetchError or mutable interceptor contexts publicly.
- Execution.replay is a new potentially paid inference from captured inputs, not a cache or offline playback. Never capture business handlers or inherit prior signals. Keep the prepared handle usable after failure.

- Duration strings use the published ms converter with strict, finite, whole-ms validation. Keep numeric *Ms aliases compatible and reject ambiguous duplicate options.
- Semantic hooks belong to one top-level operation; do not count HTTP retries as extra decisions or emit nested-helper duplicates. Events must not expose prompts, values, diagnostics or raw error causes.
- Derived clients snapshot policies and compose hooks parent-first. Never inherit AbortSignals or a running timeout into prepared/replayed work.
- Field diagnostics use lossless input path arrays, existing validated evidence, and no extra inference or Zod callbacks. Preserve inactive optional branches and distinguish input paths from transformed outputs.
