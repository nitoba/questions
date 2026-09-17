# Changelog

## 0.1.0-alpha.4

- Replace separate native/Gateway HTTP paths with shared ofetch 1.5.0 dispatch and retry lifecycle, preserving bounded reads, strict parsing, redirect refusal and cancellation.
- Add public retry shorthand, custom statuses, explicit network retry, fixed/custom delays and safe asynchronous HTTP hooks; default retries remain disabled.
- Add typed `q.run` results with evidence and live replay, plus `q.prepare` for reusable snapshots and recovery after errors. Preserve provider/confidence defaults but never reuse prior AbortSignals.
- Preserve collection rounding metadata through schema revalidation and remove abort listeners immediately when aborting pending work.
- Add installed-dependency consumer tests, HTTP/replay contracts and a documented ofetch-inspired DX roadmap. Independent streams and the SDK bridge still do not load ofetch or Zod.

## 0.1.0-alpha.3

- Add TypeSafe and configurable System One providers while preserving Jev and its baseUrl alias.
- Add optional Vercel AI Gateway support through the official Evaluation V4 SDK.
- Add a dependency-free structural bridge for existing AI SDK evaluation models.
- Preserve confidence provenance, explicit rounding, warnings and provider metadata; never fabricate absent distributions.
- **Type change:** token usage counters are optional when the upstream provider does not report them.
- Harden shared HTTP cancellation/cleanup, credential-safe configuration and bounded response reads.
- Add runtime, compile-only, real localhost SDK and independently installed tarball coverage; document provider setup and protocol differences.

This implementation does not publish the package or run paid live-model evaluations.
