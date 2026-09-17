# Providers and protocols

A **provider** is the public integration you configure. An **adapter** is the implementation that translates its protocol into `QuestionModel`. The application supplies one model to `Questions.create({ model })`; its schemas, question batches, confidence gates, handlers and streams stay unchanged.

Changing a URL is not enough when request and response formats differ. System One uses `POST /systemone` with `noul` booleans. Vercel evaluation uses the AI SDK's Evaluation V4 contract, **not** OpenAI Chat Completions. This package neither calls a chat endpoint nor simulates probabilities with generated JSON.

## Choose an integration

| Integration        | Use it for                                                | Installation beyond Questions and Zod                                     |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `TypeSafe.create`  | Direct TypeSafe AI access                                 | None                                                                      |
| `SystemOne.create` | A host/proxy implementing the System One protocol         | None                                                                      |
| `Jev.create`       | Existing code; compatible TypeSafe preset                 | None                                                                      |
| `Vercel.create`    | Vercel AI Gateway via the official SDK, with bounded HTTP | `@ai-sdk/gateway`                                                         |
| `AISDK.create`     | Reuse any compatible AI SDK Evaluation V4 model           | Whatever package creates that model; the bridge itself has no SDK imports |

TypeSafe, SystemOne and Jev are exported at the root and through their individual `/providers/...` subpaths. Vercel and the general AI SDK bridge use explicit subpath imports. **The root does not load the optional Gateway SDK.** Streams, native HTTP providers and the AI SDK bridge are independently importable without Zod.

## TypeSafe: minimal configuration

```ts
import { Questions, TypeSafe } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");
const questions = Questions.create({
  model: TypeSafe.create({ apiKey, timeoutMs: 15_000 }),
});
```

Defaults: `https://api.typesafe.ai/v1`, model `jev-latest`, relative path `systemone`. It is a preset of the shared ofetch-based System One transport, not a separate copy of HTTP/retry code. `Jev.create` remains supported, including the old `baseUrl` spelling. New APIs consistently use `baseURL`; supplying both spellings to Jev is rejected.

## Vercel: same application, different provider

Install Questions, Zod and the optional Gateway SDK from npm:

```sh
bun add @nitoba/questions zod @ai-sdk/gateway
```

```ts
import { z } from "zod";
import { Questions, Schema, Streams } from "@nitoba/questions";
import * as Vercel from "@nitoba/questions/providers/vercel";

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("Set AI_GATEWAY_API_KEY");

const questions = Questions.create({
  model: Vercel.create({
    apiKey,
    model: "typesafe-ai/jev", // the default; accepts other evaluation IDs
    timeoutMs: 15_000,
    maxResponseBytes: 1_048_576,
  }),
});

const triage = z.object({
  urgent: z.boolean().describe("Does this incident prevent production work?"),
  team: z.enum(["billing", "platform"]).describe("Which team should investigate?"),
  impact: z
    .number()
    .min(0)
    .max(2)
    .register(Schema.registry, {
      kind: "score",
      instructions: "How disruptive is this incident?",
      levels: ["Minor", "Impaired", "Unavailable"],
    }),
});

const result = await questions.about("The production API returns 503").ask(triage);
// { urgent: boolean; team: "billing" | "platform"; impact: number }

const readable = Streams.from(["API outage", "Invoice request"])
  .map((ticket, { signal }) => questions.about(ticket).ask(triage, { signal }), {
    concurrency: 4,
  })
  .toReadable(); // native ReadableStream<z.output<typeof triage>>
```

The adapter creates an official `gateway.evaluationModel(...)` and calls `doEvaluate` once; configured transport retries may make additional HTTP attempts within that call. It does **not** call AI SDK core `evaluate`, which has its own default retry policy. Gateway service-side routing, caching and fallback policies remain the service's responsibility. `providerOptions` forwards explicit JSON namespaces without claiming every option is supported by every model.

`apiKey` is required: this convenience API does not silently read credentials from the environment. `teamIdOrSlug`, `headers`, `fetch` and an SDK-compatible `baseURL` can be configured. The default prefix is `https://ai-gateway.vercel.sh/v4/ai`; a proxy prefix must implement that SDK protocol, not `/v1/chat/completions` or System One. The official SDK still owns its protocol headers and may add deployment/request metadata in a Vercel environment.

This integration targets the **experimental Evaluation V4** contract. Install `@ai-sdk/gateway` and `zod` by name and let your package manager resolve compatible current releases. Questions targets Zod 4. No live-model accuracy, account permissions or billing behavior is established by the offline tests.

## System One: explicit endpoint and model

```ts
import { Questions, SystemOne } from "@nitoba/questions";

const baseURL = process.env.INFERENCE_BASE_URL;
const apiKey = process.env.INFERENCE_API_KEY;
const model = process.env.INFERENCE_MODEL;
if (!baseURL || !apiKey || !model) throw new Error("Configure the inference endpoint");

const questions = Questions.create({
  model: SystemOne.create({
    baseURL, // includes /v1 or any proxy prefix
    apiKey,
    model,
    name: "Internal inference", // diagnostic label, not the model ID
    path: "systemone", // relative path appended to the prefix
    headers: { "x-project-id": "support" },
    timeoutMs: 15_000,
  }),
});
```

The host must accept `{ state, model, questions }` with `noul`, `choice` and `score`, and return System One `answers` plus snake-case usage counters. Structured choice descriptions are encoded as JSON text. A compatible host can configure `maxCriteria`; the default is 255. This is not a promise that an arbitrary hosting service implements the protocol.

Credentials may be **explicitly omitted** for a trusted unauthenticated endpoint, such as a local deployment. There is no implicit TypeSafe model, URL or credential fallback. `baseURL` and `model` are required. URLs reject embedded credentials, query parameters and fragments. Relative endpoint paths reject traversal and absolute URLs. Headers are snapshotted and cannot replace managed authentication/protocol headers. Use trusted configuration, not an unvalidated URL from an end user.

HTTP retries are opt-in for System One/TypeSafe and Vercel. Their default eligible statuses are 429/529; explicit status codes and network-failure opt-in are available. `Retry-After`, the total timeout and the maximum delay remain enforced. No network, decoding, schema or application-handler error is automatically retried.

## Advanced: reuse an existing AI SDK model

```ts
import { createGateway } from "@ai-sdk/gateway";
import { Questions } from "@nitoba/questions";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";

// This SDK instance owns its authentication, including SDK-managed env/OIDC resolution.
const gateway = createGateway();
const model = AISDK.create({
  model: gateway.evaluationModel("typesafe-ai/jev"),
  timeoutMs: 15_000,
  providerOptions: { gateway: { order: ["typesafe-ai"] } },
});
const questions = Questions.create({ model });
```

The structural bridge accepts Evaluation V4 models, not language/chat models or plain string IDs. It captures `doEvaluate` with its original `this` binding, snapshots the supported question types, and checks requested capabilities before calling the SDK. All results are treated as unknown even when the SDK has a TypeScript return type.

The bridge imports **no SDK runtime or types**. Its human-readable timeout uses the small duration converter shared with the client. Its small structural boundary is checked against the installed official SDK in compile-only contracts and runtime tests. This avoids exposing the SDK's unrelated text/audio types through Questions declarations. Existing SDK model errors keep their identity. HTTP response limits, redirect behavior and authentication are owned by that supplied model; the bridge adds no transport it cannot actually control. Use `Vercel.create` for the bounded/sanitized HTTP preset.

For a completely different protocol, implement `QuestionModel.evaluate` directly. It remains the stable provider-neutral boundary; no provider registry, container or inheritance hierarchy is required.

## Evidence: do not conflate confidence metrics

Boolean answers keep the existing `P(true)` representation and confidence `abs(2 * P(true) - 1)`.

TypeSafe's native choice/score confidence is preserved with `confidenceSource: "provider"`. Evaluation V4 does not expose that field. The AI SDK bridge therefore uses the explicitly documented **top-two probability margin**, `P(first) - P(second)`, with `confidenceSource: "margin"`. A tie has margin zero. This applies to choices and rubric levels; it is **not** a claim about factual correctness, score variance, calibration, or equivalence to TypeSafe's confidence formula. Re-evaluate thresholds when switching providers.

Advanced integrations can supply `confidence: (evidence, context) => number`. It must be synchronous, return a finite value in `[0, 1]`, and ideally be pure. Evidence, distributions and context are frozen; no raw HTTP body or secrets are supplied. The complete batch and metadata are validated before any callback executes. Custom values carry `confidenceSource: "custom"`. Boolean confidence remains unchanged. Callback exceptions propagate without retry.

**Choice/score answers must include complete probability distributions.** The SDK makes these optional, but Questions rejects missing distributions instead of creating fake one-hot certainty. The rubric legend is reconstructed deterministically from the requested criteria. Invalid keys, winners, probabilities, scores or Zod output still fail before application handlers run.

## Usage, rounding and diagnostics

`Evaluation.usage.inputTokens` and `.outputTokens` are now optional. Missing means **unreported**, not zero tokens or zero cost. Preserve that distinction in accounting; use an explicit application policy for unknown counters.

`rounding`, `warnings` and `providerMetadata` are preserved when supplied and validated. Rounding must declare integer decimal places in `[0, 15]`. Checks allow half a unit in the last reported decimal place per probability and score, plus the existing floating-point tolerance. Values are not silently normalized, clamped or rounded again. No rounding declaration means the original strict checks. Zero-total distributions remain invalid. Arithmetic over rounded probabilities retains their approximation error; expected-loss outputs are therefore approximate too.

`Schema.compile(...).parse(evidence)` revalidates this normalized envelope, including the same rounding information. The reported model ID is taken from the SDK response when available, otherwise the configured ID; it is not independent proof of the Gateway's internal routing decision.

Warnings are returned rather than printed. Provider metadata is JSON-snapshotted and frozen, but may still contain sensitive service diagnostics. Raw SDK response bodies and headers are not copied into evidence. The Vercel preset sanitizes HTTP/network/SDK decoding failures to `ProviderError`; the generic AI SDK bridge preserves the supplied model's errors, which may contain request details. Sanitize application logs accordingly.

## Cancellation and verification

The Vercel preset limits successful HTTP response bytes before SDK JSON parsing, handles fragmented UTF-8, prohibits redirect following, cancels late responses and releases its readers. Its timeout covers SDK authentication, HTTP and body reading. A custom transport can ignore its signal, so cancellation stops waiting but cannot undo an already accepted upstream evaluation or guarantee that billing stopped. In-flight application callbacks must cooperate with cancellation too.

Tests cover the real installed Gateway SDK with injected HTTP and an actual localhost server, schema transforms, collection batching, streams, missing distributions, precision, diagnostics, confidence policies, capability checks, cancellation, no implicit retries and credential-safe failures. Separate tarball consumers verify native use **without the SDK installed** and Gateway use **with its real dependency graph installed**, under Node and Bun. Own package declarations are checked without ambient Node/Bun types. No live API key is used.

## Sources inspected

- [Vercel evaluation documentation](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Vercel model catalog](https://ai-gateway.vercel.sh/v1/models) (`typesafe-ai/jev`, evaluation V4, checked September 17, 2026)
- [Official SDK evaluation implementation](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts)
- [Evaluation V4 contract](https://github.com/vercel/ai/tree/main/packages/provider/src/evaluation-model/v4)
- [TypeSafe System One API](https://docs.typesafe.ai/api)
- [TypeSafe confidence semantics](https://docs.typesafe.ai/confidence)

## HTTP and replay (alpha.4)

Questions-owned transports now use ofetch with the shared `retry`/`hooks` configuration. The arbitrary AI SDK model bridge retains ownership boundaries and adds no HTTP retry policy of its own. `q.run(schema)` exposes validated output/evidence plus explicit live replay; `q.prepare(schema)` captures a reusable request without inference. See [HTTP and replay](http-retry-replay.md) for exact semantics and the ofetch feature evaluation.

## Client-level policy versus transport policy (alpha.5)

Every provider timeout now accepts a typed duration through timeout, retaining numeric timeoutMs as an exclusive compatibility alias. HTTP retry options similarly accept initialDelay, maxDelay and delay; the generic AISDK bridge still cannot control another instance's transport retry policy. Questions client defaults and semantic hooks observe full operations, while provider hooks remain HTTP-attempt events. See [semantic DX](semantic-dx.md) for the exact grammar, precedence and limits.

## Generative language models (alpha.6)

[Generative.create](generative.md) accepts configured LanguageModelV4 instances from AI SDK 7.
It is separate from this guide's Evaluation V4 bridge: it requests complete estimated distributions
through structured generation, computes winners/scores locally, and marks every answer
`probabilitySource: "estimated"`. Install `ai` and the chosen SDK provider; `@ai-sdk/provider` does not need to be installed directly by the consumer. Existing `AISDK.create()` still rejects incomplete evaluation distributions.
The System One adapters now mark probabilities `provider`; absent provenance on other custom/SDK
models remains unknown. These labels describe origin, not calibration.
