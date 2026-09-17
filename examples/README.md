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

Run most later tutorials against either provider:

```sh
TYPESAFE_API_KEY='your-own-key' bun examples/07-zod-decision-schemas.ts
QUESTIONS_PROVIDER=vercel AI_GATEWAY_API_KEY='your-own-key' bun examples/07-zod-decision-schemas.ts
```

Tutorials 01 and 10 intentionally show direct TypeSafe configuration. Tutorial 12 has its own
explicit provider selector. Others reuse only the credential/configuration plumbing in
[shared/runtime.ts](shared/runtime.ts); the semantic operations remain visible in each file.

Every live entry point requires real credentials. There is **no automatic fake model**, offline
fallback, model substitution, or invocation of every provider. The optional Gateway SDK is
installed in this repository for development. In a consuming project, install the Gateway peer
only when using that provider; see [provider setup](../docs/providers.md). Native question batches
use no Zod schema in application code, although this release's root package still declares the
Zod peer. They are not arbitrary JSON Schema or another validation-library adapter.

Imports point at `../src` so tutorials run without building first. When copying a tutorial into
another project, replace these with `@nitoba/questions` and its documented subpath imports.

Environment variables are documented in [.env.example](.env.example). Copy values into your own
environment or a gitignored local `.env`; never commit keys.

## Curriculum

Run each file separately. There is deliberately no "run all live examples" command.

| Lesson                                                               | Scenario and learning objective                                                            | Zod            | Streams | Model evaluations per run                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------- | ------- | ---------------------------------------------- |
| [01: First question](01-first-question.ts)                           | Museum accessibility request; explicit client, yes/no and probability                      | No             | No      | 2                                              |
| [02: Native decision shape](02-native-question-schema.ts)            | Equipment maintenance; typed `Question.Batch`, choices and score rubric                    | No             | No      | 2                                              |
| [03: Original objects and routes](03-select-and-route.ts)            | Conference room selection, ranking and one selected checklist handler                      | No             | No      | 3                                              |
| [04: Collection batching](04-collection-batching.ts)                 | Catalog enrichment; descriptions exclude private cost fields                               | No             | No      | 3 batched calls                                |
| [05: Live context](05-live-context-investigation.ts)                 | Bounded deployment investigation with an ordinary async/await loop                         | No             | No      | Up to 4                                        |
| [06: Evidence and cost](06-evidence-and-decision-costs.ts)           | Editorial review; compare multiple local policies over one distribution                    | No             | No      | 1                                              |
| [07: Decision schemas](07-zod-decision-schemas.ts)                   | Return assessment; descriptions, metadata, registry, score/probability, transformed output | Yes            | No      | 1                                              |
| [07b: Advanced schema inputs](07b-zod-advanced-inputs.ts)            | Survey assessment; tuples, optional/null/default presence, brands, readonly, Mini          | Classic + Mini | No      | 2; constants add 0                             |
| [08: Diagnostics](08-schema-diagnostics.ts)                          | Document intake; field paths, confidence rejection, retained evidence                      | Yes            | No      | 1                                              |
| [09: Derived clients](09-derived-clients-and-observability.ts)       | Release-review policies; immutable defaults and semantic hook composition                  | No             | No      | 3                                              |
| [10: HTTP resilience](10-http-retries-and-deadlines.ts)              | Carrier investigation; durations, retry lifecycle and cancellation                         | No             | No      | 1, up to 3 HTTP attempts                       |
| [11: Preparation and replay](11-preparation-and-replay.ts)           | Procurement notice; captured context and explicit provider comparison                      | Yes            | No      | 2; optional comparison adds 1                  |
| [12: Providers and custom models](12-providers-and-custom-models.ts) | Course classification; presets, protocols, Evaluation V4 and a measured decorator          | No             | No      | 1                                              |
| [13: Bounded pipelines](13-bounded-stream-pipelines.ts)              | Search-result screening and micro-batching, without re-consuming the paid pipeline         | No             | Yes     | Up to 8                                        |
| [14: Stateful streams](14-stateful-streams.ts)                       | Session feedback; transition events, summaries and early termination                       | No             | Yes     | Up to 3                                        |
| [15: Web API interoperability](15-native-stream-interop.ts)          | NDJSON report through native readers, transforms, Response and sinks                       | No             | Yes     | **0; no key required**                         |
| [16: Fulfillment desk](16-fulfillment-desk/README.md)                | Persistent case processing, review API, atomic outbox and deduplicated delivery            | Yes            | Mixed   | One per claimed case; all other commands add 0 |

Additional lesson: [17: Generative language models](17-generative-models.ts) uses internal prompts
and the same finite schemas with Gemini, Claude, GPT or Gateway. It performs one evaluation,
uses Zod without streams, and records estimated probability provenance. Select `GENERATIVE_PROVIDER`
and `GENERATIVE_MODEL` explicitly; see [the generative guide](../docs/generative.md) for credentials
and SDK requirements. It does not change the TypeSafe defaults of earlier tutorials.

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

The tutorial tests import and execute the actual exported tutorial functions using a deterministic
provider fixture. HTTP resilience tests use the installed ofetch transport. The capstone tests
exercise real SQLite files, a real loopback HTTP server, partial intake, conflicting IDs,
concurrent claims, cancellation, rejected confidence, operator approval, version conflicts,
and lost-acknowledgement redelivery. No cloud credentials are needed.

`bun run check` typechecks **every example module**, runs the library and example Bun tests,
checks formatting/lint, builds and validates installed packages, and checks local documentation
links. The core library suite also runs on Node in CI. The capstone's host tests run on Bun
because they deliberately use `bun:sqlite` and `Bun.serve`.

## Useful next experiments

Change a rubric and observe fractional scores in 02. Compare cost tables without another
inference in 06. Add an optional field and inspect its presence diagnostic in 08. Alter a
notice after preparation in 11. Cancel 13 before it drains. Follow the failure/recovery
walkthrough in 16 before adapting its persistence to your own application.
