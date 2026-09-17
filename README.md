# Questions

Typed semantic decisions in ordinary TypeScript, without Effect.

This repository is being implemented as an independent library inspired by the public API of [effect-questions](https://github.com/saiashirwad/effect-questions). It targets Bun and Node with platform-native `Promise`, `AbortSignal`, `ReadableStream`, `TransformStream`, and `WritableStream`.

## Design

- Explicit provider injection: `Questions.create({ model })`; no global singleton or hidden runtime.
- Preserve `about`, `is`, `ask`, `probability`, `score`, `choose`, `rank`, `branch`, `evidence`, and batched `each`.
- Keep question definitions, evidence mathematics, decision policies, HTTP transport, and stream composition separate.
- Ordinary promises for individual evaluations; lazy stream factories for repeatable pipelines. No implicit replay, retries, or memoization.
- A small stream facade with bounded concurrency and cancellation, plus direct Web Streams access for advanced consumers.
- Jev implements TypeSafe's documented `POST /v1/systemone` JSON protocol. Streaming means processing input items, not inventing a token-streaming endpoint.
- Validate untrusted responses, probability distributions, option keys, and score legends before decisions execute handlers.
- TypeScript 7, Bun, Oxlint, Oxfmt, tsdown, runtime and compile-time contract tests, and package smoke tests.

The initial implementation is developed through incremental commits on `main`. No npm release is performed as part of implementation.
