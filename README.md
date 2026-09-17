# Questions

**Typed semantic decisions for TypeScript.** Ask questions about your data, inspect the evidence,
and decide what happens next using ordinary `async`/`await` or native Web Streams.

Define decisions with Zod 4 schemas or native typed question batches. Switch between TypeSafe AI,
Vercel AI Gateway and compatible endpoints without rewriting your questions. Add confidence gates,
readable deadlines, explicit retries, replay and observability as your application grows.

No Effect dependency, service container or alternative execution runtime. Independently inspired
by [effect-questions](https://github.com/saiashirwad/effect-questions).

> **Alpha:** this README describes the `0.1.0-alpha.5` API. See the [changelog](CHANGELOG.md)
> and [migration guide](docs/migration.md) before upgrading. Decisions are finite classifications,
> not arbitrary JSON generation, factual guarantees or authorization to execute business actions.

[Quick start](#quick-start) · [Providers](#providers) · [Schemas](#zod-schemas) ·
[Streams](#web-streams) · [Tutorials](examples/README.md) · [Documentation](#documentation)

## Quick start

Use the Bun version pinned in [package.json](package.json) to work on the repository:

```sh
git clone https://github.com/nitoba/questions.git
cd questions
bun install --frozen-lockfile
bun run test:examples
```

The tests require no API keys and do not call paid models. To run a live tutorial:

```sh
TYPESAFE_API_KEY='your-own-key' bun examples/01-first-question.ts
```

The [learning path](examples/README.md) includes native questions, Zod, non-streaming workflows,
streams and a complete application. [Environment setup](examples/.env.example) documents the
available provider settings. Live commands may incur charges; there is no automatic fake-model
fallback or command that runs every paid tutorial.

### Use a local build in another project

These commands do not depend on the package being published to npm:

```sh
# In this repository:
bun run build
bun pm pack --filename /tmp/questions.tgz

# In your application:
cd ../your-app
bun add /tmp/questions.tgz 'zod@^4.0.0'
```

The root import requires the Zod 4 peer, even when your application uses only native question
batches. Vercel support has an additional optional peer; see [Providers](#providers).
The examples in this repository import source files so they can run without a build.
The snippets below use package imports and run in server-side TypeScript on Node or Bun.

```ts
import { Questions, TypeSafe } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");

const questions = Questions.create({
  model: TypeSafe.create({ apiKey, timeout: "15 seconds" }),
});

const ticket = {
  title: "Production API is unavailable",
  details: "Every request returns 503 after the deployment.",
};

const urgent = await questions.about(ticket).is("Is production work blocked?");
console.log(urgent); // boolean, inferred and validated
```

Later snippets reuse `questions` and `ticket`. Each operation invocation starts new work;
re-awaiting the same Promise does not. Construction alone performs no inference.

## Providers

All integrations return a `QuestionModel` for `Questions.create({ model })`:

| Integration          | Purpose                                              | Configuration                                              |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `TypeSafe.create()`  | Direct TypeSafe AI access                            | Explicit `apiKey`; default model `jev-latest`              |
| `SystemOne.create()` | A host implementing the System One protocol          | Explicit `baseURL` and `model`; optional `apiKey`          |
| `Vercel.create()`    | Official Vercel AI Gateway evaluation SDK            | Explicit `apiKey`; default model `typesafe-ai/jev`         |
| `AISDK.create()`     | Reuse an existing AI SDK evaluation model            | An Evaluation V4 model instance                            |
| `Jev.create()`       | Compatible TypeSafe preset for existing applications | Retains its diagnostic name and the old `baseUrl` spelling |

### Vercel AI Gateway

In the consuming project, install the optional Gateway peer and a compatible Zod version:

```sh
bun add '@ai-sdk/gateway@^4.0.85' 'zod@^4.1.8'
```

```ts
import * as Vercel from "@nitoba/questions/providers/vercel";

const gatewayKey = process.env.AI_GATEWAY_API_KEY;
if (!gatewayKey) throw new Error("Set AI_GATEWAY_API_KEY");

const gatewayQuestions = Questions.create({
  model: Vercel.create({ apiKey: gatewayKey, timeout: "15 seconds" }),
});

const viaGateway = await gatewayQuestions.about(ticket).is("Is production work blocked?");
```

The root does not import the optional Gateway SDK. The SDK bridge is available separately at
`@nitoba/questions/providers/ai-sdk`. TypeSafe and SystemOne are also available through their
own subpaths. New configuration uses `baseURL`.

**A different URL is not a different protocol.** SystemOne expects System One request/response
JSON; Vercel uses the SDK's evaluation protocol, not OpenAI-compatible chat. `AISDK.create()`
accepts evaluation models, not language/chat models. Schemas and stream pipelines remain the
same, but confidence metrics can differ between providers.

See the [provider guide](docs/providers.md) and
[provider tutorial](examples/12-providers-and-custom-models.ts) for custom endpoints,
transport injection, existing SDK instances and implementing `QuestionModel.evaluate`.

## Zod schemas

One schema supplies instructions, inferred output types and runtime validation:

```ts
import { z } from "zod";
import { Schema } from "@nitoba/questions";

const triage = z.object({
  urgent: z.boolean().describe("Does the issue prevent production work?"),
  team: z.enum(["billing", "platform"]).meta({
    description: "Which team should investigate?",
    questions: {
      options: { billing: "Invoices and payments", platform: "API and deployments" },
    },
  } satisfies Schema.Metadata),
  impact: z
    .number()
    .min(0)
    .max(2)
    .register(Schema.registry, {
      kind: "score",
      instructions: "How disruptive is the incident?",
      levels: ["Minor", "Impaired", "Unavailable"],
    }),
});

const result = await questions.about(ticket).ask(triage);
// { urgent: boolean; team: "billing" | "platform"; impact: number }
type Triage = z.output<typeof triage>;
```

`ask(schema)` uses asynchronous Zod parsing and returns `z.output<S>`, including output
transforms, refinements, defaults, brands and readonly modifiers. Independent decision fields
are evaluated together in one model call. Constant-only schemas need no inference.

Use `.describe()` for simple guidance, `.meta()` for standard metadata plus the `questions`
namespace, or `.register(Schema.registry, ...)` / `Schema.annotate()` for typed annotations.
Only approved guidance is forwarded, not arbitrary application metadata. Register annotations
on the final schema instance; later Zod methods can create a new instance.

Numbers need an explicit meaning: `kind: "probability"` returns `P(true)` in `[0, 1]`;
`kind: "score"` returns the weighted, zero-based rubric index. Three levels give `[0, 2]`,
including fractions. `.int()` validates; it does not round the result.

The finite-decision compiler supports booleans, enums, primitive literal unions, nested objects,
fixed tuples and supported wrappers such as optional/nullable fields. Free-form strings without
options, variable arrays, records, object unions and recursive inputs are rejected before
inference. A transform can produce richer output locally; it does not extract new facts.
Zod Classic and Mini are supported. See the [schema guide](docs/schemas.md) for the full matrix.

## Native typed questions — no Zod schema

Native definitions are a first-class alternative, not a legacy API:

```ts
import { Question } from "@nitoba/questions";

const review = {
  blocked: "Is production work blocked?",
  owner: Question.choice("Who should investigate?", {
    billing: "Invoices and payments",
    platform: "Infrastructure and deployments",
  }),
  impact: Question.score("How disruptive?", ["Low", "Impaired", "Unavailable"]),
} satisfies Question.Batch;

const nativeResult = await questions.about(ticket).ask(review);
// { readonly blocked: boolean; readonly owner: "billing" | "platform"; readonly impact: number }
type NativeResult = Question.Values<typeof review>;
```

The model's response is still validated. Native batches are named boolean, choice and score
definitions, not arbitrary JSON Schema or an adapter for another schema library.

| Operation                    | Result                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `q.is()` / `q.probability()` | Most likely boolean / `P(true)`                                |
| `q.score()`                  | Weighted rubric index                                          |
| `q.choose()` / `q.rank()`    | An original candidate / all candidates ordered by probability  |
| `q.branch()`                 | The return value of the one selected handler                   |
| `q.ask()`                    | Parsed schema output or projected native batch values          |
| `q.evidence()`               | Validated distributions, model, reported usage and metadata    |
| `q.run()`                    | Value, evidence, diagnostics, operation ID and explicit replay |
| `q.prepare()`                | Captured inputs and a reusable run handle, without inference   |

`choose` and `rank` accept arrays or keyed records and preserve original object identity; only
candidate descriptions are sent. `branch` runs no handler if its confidence gate fails, and
never retries a handler or silently selects a fallback. See [selection and routing](examples/03-select-and-route.ts).

### Live context and batches

`questions.about(() => currentContext)` reads fresh context per ordinary operation. The source
may be asynchronous and receives `{ signal }`. Prepared runs and replay keep a snapshot instead.

```ts
const tickets = [ticket, { title: "Invoice request", details: "Please resend the last invoice." }];
const batchResults = await questions.each(tickets).ask(triage);
// Triage[], in input order, from one batched evaluation
```

`each` also supports a description callback for redaction, `.is()` and `.score()`.
Empty collections perform no inference. Batching is not per-item concurrency and still obeys
provider context/criteria limits. See [batching](examples/04-collection-batching.ts) and
[live investigation](examples/05-live-context-investigation.ts).

## Defaults, hooks and durations

Derive policies without changing the original client:

```ts
const support = questions.extend({
  defaults: { confidence: 0.6, timeout: "30 seconds" },
  hooks: {
    onEvaluate: ({ operationId, operation }) => console.log("Started", operationId, operation),
    onDecision: ({ operationId, usage, elapsedMs }) =>
      console.log("Validated", operationId, usage, elapsedMs),
    onError: ({ operationId, kind, stage }) => console.log("Failed", operationId, kind, stage),
  },
});

const accepted = await support.about(ticket).ask(triage, { timeout: "10 seconds" });
```

The same `defaults` and `hooks` options work in `Questions.create()`. Precedence is
**base client < derived client < call**. Defaults and hook arrays are snapshotted; children do
not mutate parents. Schema confidence minimums cannot be weakened by a call-level override.
`timeout: false` removes an inherited operation deadline, not caller cancellation or a provider
budget. Signals belong to individual calls, never client defaults.

An operation deadline covers context, compilation, hooks, provider work including retries and
Zod parsing. Batches share one deadline; `branch()` also bounds the wait for its handler.
Provider timeouts are separate. Cancellation is cooperative and cannot undo completed effects.

Semantic hooks describe **one public operation**, not each HTTP attempt or internal helper.
`onDecision` follows validation and applicable confidence gates, before a branch handler.
`onError` classifies terminal failures. Hooks compose parent-first, may be asynchronous, and
exclude prompts, values, credentials, raw errors and field diagnostics.

`hooks: false` clears inherited hooks; `hooks: { onDecision: false }` clears one event.
Throwing hooks stop the operation without retrying. See [semantic lifecycle contracts](docs/semantic-dx.md)
for cancellation, handler failures and evidence-only operations.

### Readable time values

```ts
import { Duration, type DurationInput } from "@nitoba/questions";

const delay: DurationInput = "200 milis";
const milliseconds = Duration.toMilliseconds(delay); // 200
const configuredTimeout = Duration.parse(process.env.OPERATION_TIMEOUT ?? "30 seconds");
```

`timeout`, `initialDelay`, `maxDelay` and `delay` accept numbers in milliseconds or strings such
as `"200 ms"`, `"200 millis"`, `"1.5 seconds"`, `"2 min"` and `"1 hour"`. Conversion uses the
published `ms` package behind a strict, whole-millisecond boundary. Validate external strings
with `Duration.parse()`; unknown units, unitless strings, mixed-unit expressions and invalid
ranges are rejected. Execution timers additionally enforce platform limits.

Numeric `timeoutMs`, `initialDelayMs`, `maxDelayMs` and `delayMs` remain deprecated aliases;
do not supply both spellings. Output measurements such as `elapsedMs` remain numbers.
`@nitoba/questions/duration` is independently importable.

## HTTP retries

Questions-owned HTTP transports use ofetch. TypeSafe, SystemOne, Jev and Vercel share the same
public retry and transport-hook options:

```ts
const resilient = Questions.create({
  model: TypeSafe.create({
    apiKey,
    timeout: "20 seconds",
    retry: {
      maxRetries: 2,
      statusCodes: [429, 503, 529],
      initialDelay: "200 ms",
      maxDelay: "3 seconds",
      jitter: true,
    },
    hooks: {
      onRetry: ({ nextAttempt, delayMs }) => console.log("HTTP retry", nextAttempt, delayMs),
    },
  }),
});
```

Retries are **off by default**. `retry: 2` allows two additional attempts for `429`/`529`;
network failures require separate `networkErrors: true` opt-in. Fixed or callback `delay`
values are also supported. `Retry-After` is a minimum; excessive waits stop retries rather than
retrying too early. One total provider budget includes attempts, hooks, body reads and
abort-aware backoff.

HTTP `onRequest`, `onResponse`, `onRetry` and `onError` hooks expose safe attempt metadata.
`onResponse` means headers arrived, not successful schema validation. Parsing, invalid evidence,
confidence, Zod failures and business handlers are not automatically retried. POST retries can
duplicate work and billing; they do not guarantee idempotency. The generic AISDK bridge cannot
control retries inside an externally supplied model. See [HTTP, retries and replay](docs/http-retry-replay.md).

## Runs, preparation and replay

Use `ask()` for a value, or `run()` when you also need evidence and diagnostics:

```ts
const first = await questions.about(ticket).run(triage);
console.log(first.value, first.operationId, first.evidence?.usage);

// A NEW potentially paid inference over the same captured inputs.
const second = await first.replay({ timeout: "10 seconds" });

// Capture first, then execute. The handle remains usable even after a failed run.
const prepared = await questions.about(ticket).prepare(triage);
const fromSnapshot = await prepared.run({ timeout: "20 seconds" });
```

Replay inherits the effective model, confidence, timeout and hooks unless overridden; it gets a
fresh operation ID, deadline and signal scope. Pass `model: otherModel` to compare providers
explicitly. The previous signal is never inherited, and live context is not reread.

Replay is **new potentially paid inference**, not a cache, offline playback or durable workflow.
Zod callbacks run again; business handlers are not captured. Preparation performs neither
inference nor Zod parsing. See [replay contracts](docs/http-retry-replay.md).

## Field diagnostics and evidence

Inspect the existing run without another model call:

```ts
for (const field of first.diagnostics) {
  console.log(field.path, field.role, field.answer, field.confidencePassed);
}

const compiled = Schema.compile(triage);
console.log(compiled.fields); // Question IDs, input paths, annotations and choice mappings
const diagnostics = compiled.diagnose(first.evidence, { confidence: 0.8 });
```

Paths refer to **schema input**, before output transforms: `["a.b"]` differs from `["a", "b"]`.
Presence and value questions have distinct roles; unused optional descendants are inactive.
`diagnose()` validates evidence without enforcing confidence, executing Zod callbacks or
calling the provider. `compiled.parse(evidence)` applies confidence and parses the schema.

`SchemaValidationError` retains Zod issues/cause and diagnostics; schema-backed
`UncertainDecision` adds the field path and question ID. See [field diagnostics](docs/semantic-dx.md).

For local decisions over distributions, the `Answer` and `Decision` namespaces offer ranking,
probability grouping, expected values and expected-loss policies. The
[evidence tutorial](examples/06-evidence-and-decision-costs.ts) compares policies using one evaluation.

**Confidence is not factual certainty.** Boolean confidence is `abs(2 * P(true) - 1)`.
Choice/score evidence identifies its `confidenceSource`: provider, top-two margin or custom policy.
Thresholds are not interchangeable across providers. Missing token counts remain unknown,
not zero. Evidence/diagnostics may be sensitive; they are not included in default telemetry.

## Web Streams

Use streams for incremental work, not as a requirement for every operation:

```ts
import { Streams } from "@nitoba/questions";

const pipeline = Streams.from(tickets)
  .map((item, { signal }) => questions.about(item).ask(triage, { signal }), { concurrency: 4 })
  .filter((item) => item.urgent);

await pipeline.forEach(
  (item) => {
    console.log(item);
  },
  {
    signal: AbortSignal.timeout(Duration.toMilliseconds("30 seconds")),
  },
);
```

`map` is sequential and ordered by default. Concurrent windows bound running tasks **plus
completed outputs waiting for consumption**, per stage and by item count. `{ ordered: false }`
emits in completion order. Failures and early termination signal in-flight work and cancel
upstream; callbacks must cooperate with their signal.

The facade includes asynchronous/type-guard `filter`, `tap`, `batch`, `scan`, `mapAccum`, `take`,
`takeUntil`, `takeWhile`, `toArray`, `forEach`, `pipeTo` and `for await`. Seed factories isolate
state across runs. `toArray({ maxItems })` rejects excess output; `take(n)` truncates deliberately.

### Native escape hatch

As an **alternative** to the terminal `forEach` above, deliver NDJSON through a native response:

```ts
const body = pipeline
  .through(
    () =>
      new TransformStream<Triage, Uint8Array>({
        transform(item, controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(item)}\n`));
        },
      }),
  )
  .toReadable();

const response = new Response(body, {
  headers: { "content-type": "application/x-ndjson; charset=utf-8" },
});
```

`.toReadable()` returns a native `ReadableStream`; `.through()` creates a fresh native transform
for each run. **Every terminal consumption is new work:** using both snippets repeats inference.
Arrays are repeatable; native streams and generators are single-use. Use `Streams.defer()`
to acquire a fresh source per run. There is no implicit cache, replay buffer or `tee`.

These are streams of items and decisions, **not token streams from Jev**. Pure stream utilities
are available at `@nitoba/questions/streams` without loading Zod, ofetch, ms or the Gateway SDK.
See [stream lifetimes](docs/streams.md) and [native interoperability](examples/15-native-stream-interop.ts).

## Errors and boundaries

| Error                   | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `ValidationError`       | Invalid configuration, context, question definition or normalized evidence                |
| `ProviderError`         | Transport, HTTP status or provider decoding failure                                       |
| `TimeoutError`          | An operation or provider budget expired                                                   |
| `UncertainDecision`     | An applicable confidence gate rejected a decision                                         |
| `SchemaValidationError` | A well-formed decision failed the supplied Zod schema; original issues/cause are retained |

Caller cancellation preserves `signal.reason`; arbitrary callback failures preserve their
thrown values. These are ordinary Promise rejections, not a typed error channel. Provider
evidence is validated before schema callbacks and business dispatch. No automatic fallback,
handler retry or telemetry is added by Questions. The optional SDK/service retains its own
routing and metadata policies. Keep API keys server-side, sanitize logs, and enforce business
authorization and idempotency in your application.

## Tutorials and a complete application

The [learning path](examples/README.md) contains **16 focused tutorial files and one multi-file
application**, with English instructions, a feature coverage map and request counts.
Start with [native questions](examples/02-native-question-schema.ts),
[Zod](examples/07-zod-decision-schemas.ts), [derived clients](examples/09-derived-clients-and-observability.ts)
or [bounded pipelines](examples/13-bounded-stream-pipelines.ts). Most live lessons support
TypeSafe or Vercel. Tests never silently fall back to paid models.

The [fulfillment desk](examples/16-fulfillment-desk/README.md) combines ordinary async services,
Zod and streams with **real SQLite storage, a review HTTP API, transactional outbox and a
deduplicating notification receiver**. Its walkthrough includes failure and recovery exercises.
Operator approval is explicit; it is a runnable application slice, not a production-readiness
or exactly-once-delivery claim.

## Development and compatibility

```sh
bun run check          # Types, lint, format, tests, build, installed consumers and local doc links
bun run test:examples  # Executable tutorials, SQLite/HTTP/CLI tests and local doc links
bun run test:coverage
```

The toolchain is pinned in [package.json](package.json) and `bun.lock`: Bun, TypeScript 7,
Oxlint, Oxfmt and tsdown. tsdown builds JavaScript; TypeScript emits declarations. See
[AGENTS.md](AGENTS.md) for contribution contracts.

CI runs the core library tests on Node 22/24 and Bun, typechecks example modules, checks the
minimum Zod peer and installs packed consumers with/without the optional Gateway SDK.
The fulfillment desk host/tests deliberately use Bun's SQLite and HTTP APIs. Runtime dependencies
are `ofetch` and `ms`; Zod is a peer, and the Gateway peer is optional. The duration and pure
stream subpaths are independent of Zod; the structural SDK bridge does not load ofetch or the
Gateway SDK. Browser/edge portability is not a claim that every deployment target was tested.

## Documentation

| Guide                                                 | Details                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| [Schemas](docs/schemas.md)                            | Supported inputs, annotations, validation and compiled plans       |
| [Semantic DX](docs/semantic-dx.md)                    | Immutable clients, hooks, durations, deadlines and diagnostics     |
| [Providers](docs/providers.md)                        | Protocols, optional peers, custom models and confidence provenance |
| [HTTP, retries and replay](docs/http-retry-replay.md) | Attempt policies, captured inputs, cancellation and privacy        |
| [Streams](docs/streams.md)                            | Backpressure, resource lifetime and native APIs                    |
| [Architecture](docs/architecture.md)                  | Internal boundaries and normalized provider contract               |
| [Migration](docs/migration.md)                        | Effect differences and compatibility notes                         |
| [Examples](examples/README.md)                        | Progressive tutorials, coverage map and the complete application   |

MIT — see [LICENSE](LICENSE).
