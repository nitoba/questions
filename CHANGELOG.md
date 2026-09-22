# Changelog

## Unreleased — policies and descriptive routing

- Add immutable `Policy.from()` definitions over native questions and required, shape-preserving Zod decisions, with typed conditions and static literal-union results.
- Add probability cutoffs, three-valued composition, priority-preserving uncertainty and `UncertainPolicyError` with trace/evidence.
- Add `about(data).decide(policy)` and a `run(policy)` overload with traces, preserving full-batch validation, confidence gates, lifecycle scopes and new-inference replay.
- Extend `branch()` with descriptive alternatives, local eligibility, probability/margin selection, collision-free rejection and typed uncertainty/unmatched errors and callbacks. Preserve function-only calls without new criteria.
- Add runtime, type-contract and installed-package coverage; document the initial Zod policy boundary and include executable tutorial 18.
- No dependency, package-version or publication changes.

## 0.1.0-rc.3

- Refresh consumer installation documentation to use unpinned package names and let package managers resolve compatible current releases.
- Stop instructing consumers to install `@ai-sdk/provider` directly; generative users install `ai` plus the provider package they use.
- Keep runtime behavior unchanged and publish this documentation/release metadata update through the tag-triggered npm Trusted Publishing workflow.

## 0.1.0-rc.2

- Republish the release candidate with the npm-first README that was added after `0.1.0-rc.1` had already been published.
- Keep the runtime API unchanged; this release only aligns the npm package documentation and release metadata with the repository.
- Publish through the existing `next` dist-tag and npm Trusted Publishing/OIDC workflow.
- Publish future release candidates and stable versions automatically from validated `v*` Git tags; RC tags use `next` and stable tags use `latest`.

## 0.1.0-rc.1

- Promote the tested alpha API to the first release candidate without adding new runtime features.
- Prepare the scoped package for public npm publication under the `next` dist-tag, with an exact-version manual release workflow and a local `npm publish --dry-run` command.
- Add npm release metadata, package discovery fields, a prepublish validation gate, and npm Trusted Publishing/OIDC for the GitHub release workflow after the first manual package publication.

- Extend the shared example selector to Google, Anthropic, OpenAI and Gateway language models; keep native evaluation available.
- Reuse that selector across native questions, Zod, streams, explicit replay comparisons and the fulfillment desk.
- Document probability provenance, SDK versus ofetch retries, installation and per-example configuration.
- Test vendor selection, missing credentials, generative tutorial workflows and human-review persistence; compile README snippets.

## 0.1.0-alpha.6

- Add the optional `Generative.create` language-model integration through AI SDK 7 structured output.
- Require explicit estimated evidence, validate full distributions, and compute choices/scores locally.
- Preserve probability provenance separately from confidence metrics, including diagnostics and probability helpers.
- Retain cancellation/deadlines, default-zero SDK retries, immutable settings, and the existing Evaluation V4 contract.
- Add official Google/Anthropic/OpenAI/Gateway contract tests, installed-consumer tests, a generative guide and tutorial 17.

## Unreleased — executable examples

- Replace the old examples with progressive English tutorials and a feature-coverage index.
- Add a runnable fulfillment-exception application with SQLite, manual review, an atomic outbox and deduplicated delivery.
- Execute tutorial functions in offline tests and validate local documentation links; library API and version are unchanged.

## 0.1.0-alpha.5

- Add provider-neutral semantic onEvaluate/onDecision/onError hooks with operation IDs, safe classifications and explicit parent/child/call composition.
- Add immutable client defaults and extend(), with total-operation deadlines covering context, hooks, retries and Zod; retain caller cancellation and schema minima.
- Add input-schema field descriptors, diagnostic inspection without inference/parse callbacks, execution diagnostics and path-aware confidence/schema errors.
- Add human-readable timeout/retry durations using published ms@2.1.3. Preserve numeric *Ms aliases, reject conflicting spellings and unknown units, and expose independent /duration utilities.
- Preserve replay policy snapshots without sharing old signals, and enforce expired monotonic deadlines when synchronous user work returns.
- Add runtime/type contracts and installed-tarball verification of new exports, optional dependencies and native stream isolation.

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

Ordinary repository changes do not publish the package. Only pushing a validated release tag triggers npm publication, and release validation does not run paid live-model evaluations.
