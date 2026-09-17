# Questions: an executable learning path

Start with one decision. Progress to typed question batches, evidence, Zod, operational policies,
Web Streams, and a persistent fulfillment-exception application. **All examples, comments,
sample data and tutorial instructions are in English.**

These examples target the repository's current **0.1.0-alpha.6** API. They replace the previous
unstructured examples; they are not compatibility wrappers around them. No library API changes
are needed to run this learning path.

## Setup and execution

From the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
```

Use the pinned Bun version in `package.json` (1.4.2). Bun executes these TypeScript entry points.
The library itself remains portable; the capstone's SQLite/CLI/server adapters are deliberately
Bun-specific application code.

Run the first tutorial:

```sh
export TYPESAFE_API_KEY='your-own-key'
bun examples/01-first-question.ts
```

### Choose one model configuration

Most lessons (02-09, 11-14, including 07b) and the paid commands of application 16 use
[shared/runtime.ts](shared/runtime.ts). It shares configuration only; each lesson keeps its
actual Questions operations visible. **The same files now work with native evaluation or
prompted generation**; there is no duplicate Gemini/Claude/GPT copy of each tutorial.

| Mode                   | Selection                                                        | Required credentials/model                         | Evidence            |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------- | ------------------- |
| Direct Jev (default)   | `QUESTIONS_PROVIDER=typesafe`                                    | `TYPESAFE_API_KEY`                                 | Evaluation protocol |
| Jev through Gateway    | `QUESTIONS_PROVIDER=vercel`                                      | `AI_GATEWAY_API_KEY`                               | Evaluation protocol |
| Gemini                 | `QUESTIONS_PROVIDER=generative`, `GENERATIVE_PROVIDER=google`    | `GOOGLE_GENERATIVE_AI_API_KEY`, `GENERATIVE_MODEL` | Estimated           |
| Claude                 | `QUESTIONS_PROVIDER=generative`, `GENERATIVE_PROVIDER=anthropic` | `ANTHROPIC_API_KEY`, `GENERATIVE_MODEL`            | Estimated           |
| GPT                    | `QUESTIONS_PROVIDER=generative`, `GENERATIVE_PROVIDER=openai`    | `OPENAI_API_KEY`, `GENERATIVE_MODEL`               | Estimated           |
| Gateway language model | `QUESTIONS_PROVIDER=generative`, `GENERATIVE_PROVIDER=gateway`   | `AI_GATEWAY_API_KEY`, `GENERATIVE_MODEL`           | Estimated           |

For example, run the **same Zod lesson** using one of these alternatives:

```sh
# Jev evaluation:
QUESTIONS_PROVIDER=typesafe TYPESAFE_API_KEY='your-own-key' \
  bun examples/07-zod-decision-schemas.ts

# Gemini structured generation:
QUESTIONS_PROVIDER=generative GENERATIVE_PROVIDER=google \
GENERATIVE_MODEL='your-structured-output-model-id' GOOGLE_GENERATIVE_AI_API_KEY='your-own-key' \
  bun examples/07-zod-decision-schemas.ts

# Claude structured generation:
QUESTIONS_PROVIDER=generative GENERATIVE_PROVIDER=anthropic \
GENERATIVE_MODEL='your-structured-output-model-id' ANTHROPIC_API_KEY='your-own-key' \
  bun examples/07-zod-decision-schemas.ts

# GPT structured generation:
QUESTIONS_PROVIDER=generative GENERATIVE_PROVIDER=openai \
GENERATIVE_MODEL='your-structured-output-model-id' OPENAI_API_KEY='your-own-key' \
  bun examples/07-zod-decision-schemas.ts

# Gateway LANGUAGE model (use its provider/model identifier), not the Jev evaluation route:
QUESTIONS_PROVIDER=generative GENERATIVE_PROVIDER=gateway \
GENERATIVE_MODEL='vendor/your-structured-output-model-id' AI_GATEWAY_API_KEY='your-own-key' \
  bun examples/07-zod-decision-schemas.ts
```

Choose a model available to your account with structured-output support. Placeholder identifiers
above are not real model recommendations. Running multiple alternatives spends on each. Set
`EXAMPLE_TIMEOUT="40 seconds"` to change the provider budget; most shared clients additionally
have a 30-second total operation deadline. A higher provider timeout does not remove that deadline.
The examples disable retries by default; lesson 10 explicitly demonstrates HTTP retries.
The generative equivalent is the adapter's `maxRetries`, not the native `retry` option.

### Intentional exceptions

01 demonstrates direct TypeSafe setup without hiding it in a factory. 10 demonstrates the
Questions-owned ofetch transport and is also TypeSafe-specific. Their CLIs ignore
`QUESTIONS_PROVIDER`; study them with a TypeSafe key or start at 02 with another model.
12 accepts an explicit positional mode (`typesafe`, `jev`, `vercel`, `sdk`, `system-one`,
`generative`); it uses `QUESTIONS_PROVIDER` only when the argument is omitted. Its `sdk` mode is
Evaluation V4, **not** a language model. 15 makes no inference and needs no key.
17 always demonstrates `Generative.create()` and reads `GENERATIVE_PROVIDER`/`GENERATIVE_MODEL`
directly, regardless of `QUESTIONS_PROVIDER`; it also respects `EXAMPLE_TIMEOUT`.

Every live evaluation needs real credentials. A missing/blank key, missing model ID or unknown
selector fails; there is **no fake-model fallback**, implicit routing or automatic provider swap.
Unused provider keys are not required. The repository includes the tested SDKs as development
dependencies. In a consuming project install only the optional integration/vendor you use:
see [native provider setup](../docs/providers.md) and [generative setup](../docs/generative.md).
The current integration uses AI SDK 7 LanguageModelV4 and Zod >=4.1.8 within v4; the native
package still supports Zod 4.0.0. Question batches use no Zod schema in application code, but
the root package still declares that peer. They are not a JSON Schema/other-schema adapter.

### Compare captured inputs deliberately

Lesson 11 always performs two evaluations of the original snapshot. A third is opt-in:

```sh
# Compare the captured Jev decision with a Google language model:
QUESTIONS_PROVIDER=typesafe TYPESAFE_API_KEY='your-typesafe-key' \
COMPARE_PROVIDER=generative COMPARE_GENERATIVE_PROVIDER=google \
COMPARE_GENERATIVE_MODEL='your-structured-output-model-id' GOOGLE_GENERATIVE_AI_API_KEY='your-google-key' \
  bun examples/11-preparation-and-replay.ts
```

`COMPARE_PROVIDER` accepts `typesafe`, `vercel` or `generative`. For a generative comparison,
`COMPARE_GENERATIVE_PROVIDER` and `COMPARE_GENERATIVE_MODEL` are independently required; the
primary `GENERATIVE_*` settings are not silently reused. Credentials use the same vendor key
variables as the table above. Both configurations are validated before the first inference.
Leave `COMPARE_PROVIDER` unset for no comparison. The older `COMPARE_WITH_VERCEL=1` remains
an alias for `COMPARE_PROVIDER=vercel`; do not set both.

This is fresh inference sent to another explicitly selected service, not offline replay or
an accuracy benchmark. The lesson prints provenance alongside values. Different estimates,
margins or native confidence values are not interchangeable measures of correctness.

Imports point at `../src` so tutorials run without building first. When copying a tutorial into
another project, replace these with `@nitoba/questions` and its documented subpath imports.

Environment variables are documented in [.env.example](.env.example). Copy values into your own
environment or a gitignored local `.env`; never commit keys.

## Curriculum

There are **17 focused tutorial files and one multi-file application**. Run each separately;
there is deliberately no "run all live examples" command. Read 17 before adapting 16 to a generative model.

| Lesson                                                               | Scenario and learning objective                                                                  | Zod            | Streams | Model evaluations per run                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------- | ------- | ---------------------------------------------- |
| [01: First question](01-first-question.ts)                           | Museum accessibility request; explicit client, yes/no and probability                            | No             | No      | 2                                              |
| [02: Native decision shape](02-native-question-schema.ts)            | Equipment maintenance; typed `Question.Batch`, choices and score rubric                          | No             | No      | 2                                              |
| [03: Original objects and routes](03-select-and-route.ts)            | Conference room selection, ranking and one selected checklist handler                            | No             | No      | 3                                              |
| [04: Collection batching](04-collection-batching.ts)                 | Catalog enrichment; descriptions exclude private cost fields                                     | No             | No      | 3 batched calls                                |
| [05: Live context](05-live-context-investigation.ts)                 | Bounded deployment investigation with an ordinary async/await loop                               | No             | No      | Up to 4                                        |
| [06: Evidence and cost](06-evidence-and-decision-costs.ts)           | Editorial review; compare multiple local policies over one distribution                          | No             | No      | 1                                              |
| [07: Decision schemas](07-zod-decision-schemas.ts)                   | Return assessment; descriptions, metadata, registry, score/probability, transformed output       | Yes            | No      | 1                                              |
| [07b: Advanced schema inputs](07b-zod-advanced-inputs.ts)            | Survey assessment; tuples, optional/null/default presence, brands, readonly, Mini                | Classic + Mini | No      | 2; constants add 0                             |
| [08: Diagnostics](08-schema-diagnostics.ts)                          | Document intake; field paths, confidence rejection, retained evidence                            | Yes            | No      | 1                                              |
| [09: Derived clients](09-derived-clients-and-observability.ts)       | Release-review policies; immutable defaults and semantic hook composition                        | No             | No      | 3                                              |
| [10: HTTP resilience](10-http-retries-and-deadlines.ts)              | Carrier investigation; durations, retry lifecycle and cancellation                               | No             | No      | 1, up to 3 HTTP attempts                       |
| [11: Preparation and replay](11-preparation-and-replay.ts)           | Procurement notice; captured context and explicit provider comparison                            | Yes            | No      | 2; optional comparison adds 1                  |
| [12: Providers and custom models](12-providers-and-custom-models.ts) | Course classification; presets, protocols, Evaluation V4 and a measured decorator                | No             | No      | 1                                              |
| [13: Bounded pipelines](13-bounded-stream-pipelines.ts)              | Search-result screening and micro-batching, without re-consuming the paid pipeline               | No             | Yes     | Up to 8                                        |
| [14: Stateful streams](14-stateful-streams.ts)                       | Session feedback; transition events, summaries and early termination                             | No             | Yes     | Up to 3                                        |
| [15: Web API interoperability](15-native-stream-interop.ts)          | NDJSON report through native readers, transforms, Response and sinks                             | No             | Yes     | **0; no key required**                         |
| [16: Fulfillment desk](16-fulfillment-desk/README.md)                | Persistent case processing, review API, atomic outbox and deduplicated delivery                  | Yes            | Mixed   | One per claimed case; all other commands add 0 |
| [17: Generative language models](17-generative-models.ts)            | Release assessment; explicit LanguageModelV4, generated distributions and probability provenance | Yes            | No      | 1                                              |

Counts describe client evaluations, not a guarantee of upstream billing: explicitly enabled
HTTP retries and a Gateway's service-side policies may add work. The sample records are fictional;
the live model's decisions are not predetermined. Never assert that a particular live result
must be `true`, or present a fixture score as a measured model-quality benchmark.

Each source file states its prerequisites, goals, request cost, expected output shape and
important pitfalls. Read the steps, run the example, change its sample input, then inspect the
inferred types in your editor. The final application has its own full walkthrough.

## Feature coverage map

Use this as a reference rather than repeating every API in every tutorial.

| Surface                                                                                                           | Where it is demonstrated                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Questions.create`, explicit model injection, eager promises                                                      | 01                                                                       |
| `about` with static JSON and live cancellable context                                                             | 01, 05, 11                                                               |
| `is`, `probability`, `score`, reusable `client.is` predicate                                                      | 01, 02, 05, 13                                                           |
| Native `Question.boolean`, `choice`, `score`, `Batch`, `Values`, `ask`                                            | 02                                                                       |
| `choose`/`rank` over arrays and keyed records, original object identity                                           | 03                                                                       |
| `branch`, single-handler dispatch, handler cancellation                                                           | 03; handler error semantics in [lifecycle guide](../docs/semantic-dx.md) |
| `each().ask/is/score`, redaction, input ordering, empty collections                                               | 04; micro-batches in 13                                                  |
| `evidence`, model/usage metadata, all public `Answer` helpers                                                     | 06                                                                       |
| `Decision.requireConfidence`, `risks`, `minimizeLoss`, `match`                                                    | 06                                                                       |
| Zod `describe`, `meta`, `Schema.registry`, `Schema.annotate`, inferred transformed output                         | 07                                                                       |
| Optional/nullable/default presence, tuples, primitive unions, refinement, brand, readonly, Mini                   | 07b                                                                      |
| `Schema.compile`, `fields`, `diagnose`, `parse`, lossless paths, inactive fields, typed errors                    | 08, 16                                                                   |
| `extend`, immutable defaults, precedence, disabling inherited policies/hooks                                      | 09                                                                       |
| `onEvaluate`, `onDecision`, semantic `onError`, correlation and safe metadata                                     | 09, 16                                                                   |
| `Duration.Input`, parsing external strings, conversion, provider and total-operation deadlines                    | 10                                                                       |
| Retries, delay functions, selected status codes, HTTP hooks, cancellation                                         | 10                                                                       |
| `prepare`, `Prepared.run`, `run`, `Execution.value/evidence/operationId/diagnostics/replay`                       | 08, 11, 16                                                               |
| TypeSafe, SystemOne, Jev compatibility, Vercel and AI SDK bridge                                                  | 12                                                                       |
| `Generative.create`, AI SDK language models, estimated evidence, default-zero SDK retries                         | 17; shared selection in 02-09, 11-14, 16                                 |
| `probabilitySource` versus `confidenceSource`, prompt version, persisted generative metadata                      | 06, 08, 11, 17; persistence in 16                                        |
| Custom `QuestionModel`, explicit confidence policy, preserving binding/signal                                     | 12                                                                       |
| `Streams.from`, type-guard/async `filter`, `map`, concurrency/order, `tap`, `batch`, `take`, `toArray`, `forEach` | 13                                                                       |
| `Streams.defer`, async sources, isolated `scan`/`mapAccum`, `takeUntil`, `takeWhile`, `for await`                 | 14                                                                       |
| `through`, native `TransformStream`, `toReadable`, `Response`, `pipeTo`, reader cleanup                           | 15                                                                       |
| Mixed stream/non-stream workflows, durable records, explicit manual review and notification delivery              | 16                                                                       |

The [schema guide](../docs/schemas.md) documents additional supported Zod wrappers and their exact
semantics; examples are not an exhaustive enumeration of every possible wrapper combination.
Unsupported free-form generation remains unsupported. Ordinary Zod validation of an incoming
HTTP payload (including free strings or discriminated unions) is different from a schema passed
to `client.ask`.

## Interpreting generative evidence

The shared adapter explicitly sets `evidence: "estimated"`. Boolean probabilities and complete
choice/score distributions come from a prompt; Questions validates them and computes winners,
weighted scores and confidence margins locally. `probabilitySource: "estimated"` is independent
of the `confidenceSource` calculation. Native `provider` provenance does not prove calibration
either. Lessons 06 and 08 display these distinctions, and application 16 persists them.

Do not treat a 0.9 estimate as 90% measured accuracy or automatically copy a Jev threshold into
Claude/Gemini/GPT. The tutorials' thresholds are illustrative review policies. Calibrate against
your own representative cases, including ambiguous cases, before automating consequential actions.
The fulfillment desk still requires operator approval for **all** proposed actions.

`Generative` rejects invalid/incomplete distributions and truncated/refused generations, without
silently repairing them or returning partial decisions. The underlying SDK owns buffering and
HTTP; its retries/transport do not use Questions' ofetch hooks. The question/schema compiler's
finite-input limits do not expand just because a language model can generate arbitrary JSON.
See [the generative guide](../docs/generative.md) for exact contracts and limits.

## Working with failures

Use [08](08-schema-diagnostics.ts) for rejected confidence and Zod diagnostics, [10](10-http-retries-and-deadlines.ts)
for transport errors, and [16](16-fulfillment-desk/README.md) for persisted recovery.

`SchemaValidationError`, `UncertainDecision`, `ProviderError`, `ValidationError` and `TimeoutError`
have different meanings; the shared CLI reports a safe category instead of dumping raw causes.
Do not add a catch-all automatic retry around a business handler. A timeout cancels the wait,
not a previously accepted inference or an already executed side effect.

`Execution.replay()` means **fresh paid inference**, not offline playback. The test fixtures are
explicitly test-only provider implementations, not an implementation of offline replay.

## Verify without paid calls

```sh
bun run test:examples
bun run check
```

The tutorial tests import and execute the actual exported tutorial functions using deterministic
fixtures. They also run native batches, Classic/Mini schemas, diagnostics, streams and replay
through the actual Generative adapter/AI SDK core. Selector tests use all four official vendor
SDKs with controlled HTTP; they do not substitute a fake model into any live command. HTTP resilience tests use the installed ofetch transport. The capstone tests
exercise real SQLite files, a real loopback HTTP server, partial intake, conflicting IDs,
concurrent claims, cancellation, rejected confidence, operator approval, version conflicts,
and lost-acknowledgement redelivery. Generative tests cover accepted and uncertain decisions
through individual and stream processing, preserving estimated provenance without approving an action.
No cloud credentials are needed; subprocess tests remove all model keys and selectors from their environment.

`bun run check` typechecks **every example module**, runs the library and example Bun tests,
checks formatting/lint, builds and validates installed packages, and checks local documentation
links. README snippets are typechecked against the built package without executing them. The core library suite also runs on Node in CI. The capstone's host tests run on Bun
because they deliberately use `bun:sqlite` and `Bun.serve`.

## Useful next experiments

Change a rubric and observe fractional scores in 02. Compare cost tables without another
inference in 06. Add an optional field and inspect its presence diagnostic in 08. Alter a
notice after preparation in 11. Cancel 13 before it drains. Follow the failure/recovery
walkthrough in 16 before adapting its persistence to your own application.
