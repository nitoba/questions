# Semantic hooks, immutable clients and field diagnostics

Available in `0.1.0-alpha.5`. All integrations keep the same `Questions.create({ model })` boundary. These features neither require Effect nor change the finite-decision protocol. They add application-level policies and observability above HTTP, with human-readable durations powered by the published `ms@2.1.3` package.

## One complete example

```ts
import { z } from "zod";
import { Questions, TypeSafe, Schema, Duration } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");

const client = Questions.create({
  model: TypeSafe.create({
    apiKey,
    timeout: "15 seconds", // provider budget, including HTTP retries
    retry: { maxRetries: 2, initialDelay: "200 ms", maxDelay: "2 s" },
  }),
  defaults: {
    timeout: Duration.parse(process.env.OPERATION_TIMEOUT ?? "30 seconds"),
    confidence: 0.6,
  },
  hooks: {
    onEvaluate: ({ operationId, operation }) => console.log("Started", operationId, operation),
    onDecision: ({ operationId, usage, elapsedMs }) =>
      console.log("Validated", operationId, usage, elapsedMs),
    onError: ({ operationId, kind, stage }) => console.log("Failed", operationId, kind, stage),
  },
});

const support = client.extend({ defaults: { confidence: 0.7, timeout: "45 s" } });
const triage = z.object({
  urgent: z.boolean().describe("Does this incident prevent production work?"),
  routing: z.object({
    team: z.enum(["billing", "platform"]).describe("Which team should investigate?"),
  }),
  impact: z
    .number()
    .min(0)
    .max(2)
    .register(Schema.registry, {
      kind: "score",
      levels: ["Minor", "Impaired", "Unavailable"],
      instructions: "How disruptive is this incident?",
    }),
});

const run = await support.about("The production API returns 503 after deployment").run(triage);
console.log(run.value.routing.team); // "billing" | "platform"
const team = run.diagnostics.find(
  (field) => field.role === "value" && JSON.stringify(field.path) === '["routing","team"]',
);
console.log(team?.questionId, team?.answer, team?.confidencePassed);
```

A confidence gate can reject this example rather than returning a value. That is intentional; handle `UncertainDecision` at your application boundary. Schema validation and confidence are not guarantees of factual correctness or authorization to perform a business action.

## Human-readable durations

Use `timeout`, `initialDelay`, `maxDelay` and `delay` instead of calculating milliseconds manually:

```ts
TypeSafe.create({
  apiKey,
  timeout: "10 seconds",
  retry: {
    maxRetries: 2,
    initialDelay: "200 milis",
    maxDelay: "3 s",
  },
});

TypeSafe.create({
  apiKey,
  retry: {
    maxRetries: 2,
    delay: ({ attempt }) => (attempt === 1 ? "250 ms" : "1 second"),
    maxDelay: "5 seconds",
  },
});
```

The same provider timeout applies to TypeSafe, SystemOne, Jev, Vercel and AISDK. Retry delays are configurable only on the HTTP integrations that Questions controls, not a transport owned by an arbitrary external SDK model. `timeout` also works in client defaults, derived defaults, every client operation, preparation and replay.

| Input                            | Milliseconds                                |
| -------------------------------- | ------------------------------------------- |
| `200`                            | 200 (numbers retain their existing meaning) |
| `"1 ms"`, `"1 millisecond"`      | 1                                           |
| `"200 milis"`, `"200 millis"`    | 200 (explicit Questions aliases)            |
| `"1 s"`, `"1 sec"`, `"1 second"` | 1000                                        |
| `"1.5 seconds"`                  | 1500                                        |
| `"2 min"`, `"2 minutes"`         | 120000                                      |
| `"1h"`, `"1 hour"`               | 3600000                                     |

Days and weeks are also supported fixed units. English singular/plural forms and common abbreviations are accepted case-insensitively at runtime. Literal types support lowercase, uppercase and initial-capital variants, with zero or one space. `Duration.parse()` additionally accepts surrounding whitespace and whitespace between the value and unit in external configuration.

`Duration.Input` (also exported as `DurationInput`) gives literal checking. A widened `string`, such as an environment variable, must be validated with `Duration.parse(value)`. Both `Duration.parse` and `Duration.toMilliseconds` return a number; numeric input is never formatted into text. The utility is independently importable as `@nitoba/questions/duration`, without loading Zod, ofetch or the Gateway SDK.

Strings must include a unit. `"100"`, `"10 secods"`, `"1s garbage"`, mixed units (`"1h 20m"`), calendar months/years, negative values, non-finite values and fractions below whole-millisecond precision are rejected. `"10 seconds"` is valid; unknown units are **not** autocorrected. Larger-unit fractions are accepted when they resolve to an integer millisecond. The parser checks the entire input (maximum 100 characters), not a substring. Runtime validation remains authoritative even if code bypasses literal checking with a cast.

The parser permits nonnegative safe-integer milliseconds. Execution timers additionally require `1..2147483647` milliseconds. Zero is valid for a retry delay, not for a timeout or maximum delay. A long duration can be valid for arithmetic but too long for the platform's timer; it is rejected before starting the operation. Durations do not add long-running scheduling, persistence or a worker runtime.

The legacy numeric fields `timeoutMs`, `initialDelayMs`, `maxDelayMs`, and `delayMs` remain supported and are marked deprecated. Supplying both an old and new spelling for the same option is an error, even when the values match. Public measurements (`elapsedMs`, retry `delayMs`, `retryAfterMs`) remain numbers, suitable for metrics and arithmetic. `Retry-After` and the existing retry ceiling continue to apply after conversion.

### Why ms, rather than a permissive natural-language parser?

We use the published, pinned `ms@2.1.3` converter with a strict input boundary and explicit `milis`/`millis` aliases. The conversion arithmetic belongs to the dependency; Questions owns its allowed deadline grammar, range checks and literal types. The repository's newer development manifest is not assumed to be a published npm release. We also evaluated `parse-duration`, which intentionally accepts compound/noisy expressions and configurable locale units. That flexibility is useful for text input but unnecessary for execution configuration, where a misspelled unit should fail rather than partially parse.

References: [ms 2.1.3](https://github.com/vercel/ms/tree/2.1.3), [parse-duration](https://github.com/jkroso/parse-duration). Neither library's entire grammar is promised by `Duration.Input`.

## Immutable defaults and derived clients

```ts
const support = client.extend({
  defaults: { confidence: 0.8, timeout: "20 s" },
  hooks: { onDecision: (event) => console.log("Support", event.operationId) },
});

await support.about(ticket).ask(schema, { confidence: 0.5, timeout: "5 s" });
const withoutClientDeadline = support.extend({ defaults: { timeout: false } });
```

Precedence is **base client < derived client < call**. `undefined` inherits. `confidence: 0` removes the call-level gate but cannot weaken schema/ancestor/selected-union-variant minima. `timeout: false` clears an inherited **operation** timeout; it does not disable an explicitly supplied AbortSignal or the selected provider's own timeout. Provider configuration (HTTP retries, authentication and transport hooks) belongs to the model and is not silently rewritten by client defaults.

A derived client is a new frozen object. Defaults and hook arrays are snapshotted; later mutations to the original configuration do not affect the client, and children never change parents or siblings. `client.defaults` exposes the effective frozen defaults, with timeout normalized to numeric milliseconds and no credentials. Functions, model closures and external application state are not deep-cloned or made pure; changing the state read by a callback can still change behavior. Model methods are captured with their original `this` binding.

Only confidence and timeout belong in `defaults`. Signals are per-operation lifetimes, so they cannot be stored there. Set hooks at client/call level. `extend({ model: otherProvider })` explicitly replaces the model while keeping the derived policies. No global provider, implicit context, mutable registry or inheritance hierarchy is required.

### Total operation deadlines

A client/call timeout covers schema compilation, live context acquisition, semantic hooks, provider work (including HTTP retry delays), evidence validation and Zod parsing. In `each().ask(schema)`, it covers the whole collection, not a renewed deadline per row. In `branch()`, it also bounds the wait for the selected handler; `onDecision` runs before that handler.

A provider's timeout starts within its evaluation, so it is a separate narrower budget. Whichever budget or caller cancellation expires first stops the wait. Monotonic checkpoints also reject an expired deadline when synchronous user code returns, before starting the next provider call, hook or batch row. JavaScript cannot preempt CPU-bound callbacks, and neither signal cancellation nor a timeout undoes an accepted inference or a business effect. Callbacks must cooperate with their signal for their own work to stop. Late promise rejections are observed and owned timers/listeners are disposed.

`q.prepare(schema)` uses its effective timeout for preparation only and emits no semantic events. The prepared request captures the policy for later runs, but not the preparation's signal or a running timer. Each `prepared.run()` has a fresh budget. An Execution's `replay()` inherits that Execution's effective provider, confidence, timeout and hook policy, unless overridden, and creates a fresh `operationId` and signal scope. It does not reread live context. Repeated `prepared.run()` calls still start from the preparation's own defaults; a previous run's overrides do not mutate the handle.

## Semantic lifecycle hooks

Configure them on `Questions.create`, `client.extend`, or a call's `hooks`. HTTP hooks remain on `TypeSafe.create`/`Vercel.create` and describe **attempts**. Semantic hooks describe one top-level public operation regardless of how many internal helpers or HTTP retries execute.

| Hook         | Meaning                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onEvaluate` | Once at the start, before schema/context work. Constants and empty batches also start an operation, even without inference.                            |
| `onDecision` | Once after successful output validation and applicable confidence gates. For `branch`, before invoking the selected handler.                           |
| `onError`    | A classified terminal operation failure, including malformed evidence, schema failure, confidence rejection, handler failure, timeout or cancellation. |

For `evidence`, `probability` and `rank`, the result is validated evidence rather than a confidence-gated action. Their established behavior is preserved: a client-level confidence setting does not prevent inspecting uncertain evidence. `onDecision` on these methods therefore means a valid result, not that a confidence gate was applied.

Internal calls do not produce duplicate events: `is()` calling `ask()` and then evaluation produces only the `is` lifecycle. A failed `branch` handler can produce **both** `onDecision` and `onError(stage: "handler")`, because the decision succeeded but its application failed. There is no success event claiming that a handler ran before it actually did. The hook names do not imply durable delivery or exactly-once external telemetry.

Each event contains `operationId`, `operation`, `provider`, `elapsedMs` and `signal`. Decision/error events include `evaluationCount`, `questionCount`, `itemCount`, and validated `usage`/`model` when available. `evaluationCount` counts model.evaluate calls, not HTTP attempts; it is zero for constants/empty batches. Usage is the provider-reported count, not the sum of hidden HTTP retries, and missing counters stay unknown. IDs correlate semantic events and `Execution.operationId`; they are **not** sent as headers or idempotency keys and do not yet join HTTP event IDs automatically.

`onError` adds `kind`, `stage` and an HTTP `status` when known. No raw errors, request/response bodies, headers, context, schema annotations, values or field diagnostics are automatically exposed to hooks. Application-provided provider names may still be descriptive, so do not place secrets in names. Caller-visible errors retain their original details and require normal logging hygiene.

### Hook composition and failure

Hooks accept a function or an array of functions. Parent callbacks run first, then derived callbacks, then call-specific callbacks. Arrays are copied; each normal event awaits callbacks sequentially. `hooks: false` clears all inherited semantic hooks. `hooks: { onDecision: false }` clears that event only. An empty array adds no callbacks; it does not remove inherited ones. A later explicit child/call hook may be added again after a reset.

A hook failure propagates unchanged, is not retried, and does not recursively invoke semantic `onError`. A failing `onEvaluate` prevents inference; a failing `onDecision` can prevent a branch handler **after inference was already completed/billed**. `onError` callbacks that throw can replace the primary error; keep telemetry callbacks nonthrowing.

On cancellation/timeout, error finalizers are invoked in array order but their async completion is **not awaited**. Their rejections are observed, and the cancellation reason wins. This prevents a stalled cleanup callback from extending an expired budget indefinitely; asynchronous cleanup completion order is not guaranteed. Configuration validation and a signal already aborted at entry occur before hooks. These hooks do not replace top-level application `try/catch` or transactional business logic.

## Diagnostics by schema input path

```ts
const compiled = Schema.compile(schema);
console.log(compiled.fields); // question IDs joined to paths before any inference

const evidence = await client.about(ticket).evidence(compiled.questions);
const diagnostics = compiled.diagnose(evidence, { confidence: 0.7 });
// No second provider call and no Zod refinement/transform execution.
const value = await compiled.parse(evidence, { confidence: 0.7 });
```

`compiled.fields` is a frozen descriptor array. `compiled.diagnose(evidence)` validates evidence and adds per-field answers, confidence, applicability and minimums. The ordinary `q.run(schema)` path provides the same information at `execution.diagnostics`. `q.ask(schema)` remains value-only.

Paths are **arrays of string keys and numeric tuple indices**. `["a.b"]` differs from `["a", "b"]`, and `["0"]` differs from `[0]`. The root is `[]`. These are paths in the **schema input**; an arbitrary transform can rename/remove/create output fields, so no fictitious mapping to transformed outputs is claimed.

Each descriptor includes `questionId`, `path`, `role`, the normalized `question`, its effective question `annotations`, and a `choices` lookup for finite-choice wire IDs when applicable. Descriptions/instructions are real supplied guidance, not model-generated explanations. The diagnostic additionally includes the validated `answer`, computed `confidence` and `active`. Active fields include `minimum` and `confidencePassed`, accounting for operation, schema, ancestor and selected alternative minima.

Optional/nullable inputs can produce a presence question and a value question at the same path, with different IDs/roles. When a parent is absent, unused child diagnostics remain present but `active: false`, with no applied minimum or pass/fail verdict. Their wire evidence is still validated. Constants generate no questions and no field diagnostics. A minimum of zero indicates no confidence restriction; passing it says nothing about Zod refinements or factual quality.

`diagnose` does not enforce confidence, run Zod callbacks or issue requests. Invalid provider evidence still throws rather than producing misleading diagnostics. Collections of descriptors, paths, evidence and annotations are snapshotted/frozen. They may contain sensitive prompts and model judgments; they are deliberately **not** attached to default semantic telemetry.

### Errors retain field evidence

```ts
import { SchemaValidationError, UncertainDecision } from "@nitoba/questions";

try {
  await support.about(ticket).ask(schema);
} catch (error) {
  if (error instanceof UncertainDecision) {
    console.log(error.path, error.questionId, error.diagnostics);
  } else if (error instanceof SchemaValidationError) {
    console.log(error.issues, error.diagnostics);
  } else {
    throw error;
  }
}
```

A schema-backed confidence rejection has its input `path`, `questionId` and the diagnostic batch; it occurs before any user parsing callback. Plain question-batch confidence errors have no schema path. Zod failures retain their original issues/cause plus diagnostics; an object-level or transformed-output issue need not correspond to one input leaf. Do not pretend `confidencePassed: true` means the schema passed. In a collection failure, paths are relative to the per-item schema; no batch index is currently added to errors. Unsupported/malformed evidence does not acquire invented field confidence.

## Compatibility and verification

Existing question batches, inference, provider defaults, HTTP retry settings, native streams, and Zod output inference remain supported. No offline replay, cache, auth-refresh retry, schema relaxation or new model capabilities are introduced. Pure streams still load no Zod, ofetch, ms or SDK runtime. The structural AISDK bridge uses the duration converter for its new timeout syntax but still loads no ofetch, Zod or Gateway SDK. `@types/ms` is development-only; public declarations expose Questions' own types.

Tests cover duration grammar and aliases, invalid values, package consumers, default/hook snapshots and precedence, all public operation entry points, replay isolation, late cancellation, synchronous deadline overrun, total batch parsing, schema path collisions/tuples, absent branches, selected-alternative minima, and zero extra inference or Zod callbacks for diagnostics. The same runtime suite runs under Bun and Node; installed-tarball consumers are checked without ambient Node/Bun types. No API key or paid model call is required to run the tests.

## Ordered rules and descriptive branches

For reusable multi-question decisions, use `Policy.from(...).when(...).otherwise(...)` with
`about(data).decide(policy)` or `run(policy)`. `branch()` also accepts descriptive alternatives,
local eligibility and explicit ambiguity/rejection handling. Existing APIs remain compatible;
see [policies and routing](policies.md) and [tutorial 18](../examples/18-policies-and-routing.ts).
