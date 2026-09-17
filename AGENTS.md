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
