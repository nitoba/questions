# Generative decision providers

Available in `0.1.0-alpha.6`. Use an AI SDK language model to answer Questions' finite decisions
with an internal prompt and structured JSON output. Gemini, Claude, GPT and Gateway language
models share the same integration. The selected model must support the requested structured
output; a provider's presence in the SDK does not guarantee every model supports it.

## Install only the integration you use

For an installed local Questions tarball (or a published version once available):

```sh
bun add ./questions.tgz 'zod@^4.1.8' 'ai@^7.0.105' '@ai-sdk/provider@^4.0.17' '@ai-sdk/google@^4.0.74'
```

Choose `@ai-sdk/anthropic`, `@ai-sdk/openai` or `@ai-sdk/gateway` instead of Google as needed.
`ai` and `@ai-sdk/provider` are optional peers of Questions, resolved only by consumers using this
integration. The latter supplies the precise public `LanguageModelV4` type without pulling the
large AI SDK barrel into Questions' declarations. The three vendor SDKs are development dependencies
for tests/examples, not dependencies of Questions. No generative export is added to the root barrel.

The native Questions API still supports Zod 4.0.0 and does not load AI SDK packages. This optional
integration requires Zod >=4.1.8 within v4 because of its SDK dependencies. The tested versions are
AI SDK 7.0.105, provider 4.0.17, Google 4.0.74, Anthropic 4.0.56, OpenAI 4.0.69 and Gateway 4.0.85.
Only configured `LanguageModelV4` instances are supported in this release, not V2/V3 instances,
string model IDs, embedding models, or evaluation models. Strings would enable implicit routing.

**TypeScript note:** the tested upstream provider declarations require `@types/json-schema` for
`skipLibCheck: false`; install it as a development dependency (`bun add -d @types/json-schema`).
Their full SDK/provider-utils declarations also have independent Node `Buffer` references and
`exactOptionalPropertyTypes` constraint errors. Questions' installed declarations are tested with
`skipLibCheck: false`, no ambient Node/Bun types, and the JSON Schema types. Assignability of all
four actual SDK factories is separately checked with the repository's existing `skipLibCheck: true`.
Questions does not patch upstream declarations or modify the consumer's compiler settings.

## Configure a model, keep your schema

```ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { Questions, Schema } from "@nitoba/questions";
import * as Generative from "@nitoba/questions/providers/generative";

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const modelId = process.env.GENERATIVE_MODEL;
if (!apiKey || !modelId) throw new Error("Set the Google API key and a supported model ID");
const google = createGoogleGenerativeAI({ apiKey });

const client = Questions.create({
  model: Generative.create({
    model: google(modelId),
    evidence: "estimated",
    timeout: "20 seconds",
  }),
  defaults: { timeout: "30 seconds" },
});

const triage = z.object({
  urgent: z.boolean().describe("Does the incident prevent production work?"),
  team: z.enum(["billing", "platform", "manual_review"]).describe("Which team should investigate?"),
  impact: z
    .number()
    .min(0)
    .max(2)
    .register(Schema.registry, {
      kind: "score",
      instructions: "How disruptive is this incident?",
      levels: ["Minor", "Service impaired", "Broad outage"],
    }),
});

const run = await client.about("The production API returns 503 after deployment.").run(triage);
console.log(run.value); // { urgent: boolean; team: ...; impact: number }
console.log(run.diagnostics);
```

The model does not receive the original executable Zod schema. Questions compiles it to normalized
questions; the adapter builds a separate JSON Schema for estimated distributions. Descriptions,
approved metadata, criteria and annotations pass through the existing compiler. The returned evidence
is validated before the original Zod schema, refinements and transforms execute locally.

Native question batches work without declaring any Zod schema in application code:

```ts
import { Question } from "@nitoba/questions";

const values = await client.about("A report of a delayed shipment").ask({
  actionable: "Does the report identify a concrete problem?",
  owner: Question.choice("Who should investigate?", {
    carrier: "Transit, delivery attempts or tracking events",
    warehouse: "Picking, packing or dispatch",
    manual_review: "Insufficient information",
  }),
});
```

Schemas unsupported by the finite-decision compiler remain unsupported. This provider does not
silently expand `ask()` into arbitrary JSON extraction, free-form generation or tool execution.

## Other providers and Gateway

The model factory is the only difference:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";

// Each variable below is an explicitly configured language model, not an evaluation model.
const claude = createAnthropic({ apiKey: anthropicKey })(claudeModelId);
const gpt = createOpenAI({ apiKey: openaiKey })(gptModelId);
const routed = createGateway({ apiKey: gatewayKey })(gatewayModelId);

const other = client.extend({ model: Generative.create({ model: claude, evidence: "estimated" }) });
```

Set those keys/IDs in the application; the adapter does not read environment variables or choose a
model on your behalf. The executable [tutorial 17](../examples/17-generative-models.ts) shows complete
configuration for each provider with explicit environment variables.

`AISDK.create()` remains the separate Evaluation V4 adapter. Some experimental SDK evaluation
wrappers return choices/scores without distributions; those still fail its strict contract.
`Vercel.create()` remains the convenient preset for Gateway evaluation. For a generative Gateway
model, use `Generative.create({ model: gateway(id), evidence: 'estimated' })` instead.

## What estimated evidence means

The acknowledgement `evidence: 'estimated'` is mandatory. The adapter asks for:

| Decision | Generated data                                   | Local projection                                              |
| -------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Boolean  | Estimated `P(true)`                              | `P(true) >= 0.5`; confidence is `abs(2 * P(true) - 1)`        |
| Choice   | Estimated mass for every declared alternative    | Highest mass; ties preserve declared object enumeration order |
| Score    | Estimated mass for every zero-based rubric level | `sum(index * probability)`; fractional scores are valid       |

For choice/score, default confidence is the top-two probability margin. It is not an estimate of
classification accuracy. Scores and winners are calculated from the validated distribution rather
than redundantly generated by the model. The original rubric legend is reconstructed locally.

Every generated answer has `probabilitySource: 'estimated'`, independently of its `confidenceSource`
(`margin` or `custom` for choice/score). The optional `ProbabilitySource` contract also permits
`provider` (probabilities delivered by an evaluation protocol) and `custom`. System One adapters
mark their evidence `provider`; generic SDK/custom models without provenance remain unknown.
No inference about native calibration is made from that marker. `Answer.fromBoolean` and `coarsen`
preserve a declared source; scalar calculations have no metadata wrapper.

The evaluation retains the model ID, reported usage, SDK warnings and provider metadata. The
reserved `providerMetadata.questionsGenerative` namespace records the strategy `prompted-distribution`,
requested model, SDK provider and exported `PROMPT_VERSION`. SDK metadata cannot overwrite it.
Fields and error diagnostics retain each answer's source. Missing token counts remain unknown.

A prompt-elicited 0.8 is **not proof of 80% correctness**, a token log-probability or a calibrated
posterior. Expected-loss calculations remain available, but their usefulness depends on your data
and calibration. Validate thresholds on representative cases, including ambiguous inputs, before
using model output for consequential decisions. Explicit manual-review alternatives and independent
authorization checks belong to the application.

### Custom confidence policy

```ts
const model = Generative.create({
  model: google(modelId),
  evidence: "estimated",
  confidence(evidence, context) {
    // A pure application policy over already-validated probabilities.
    // Do not mutate evidence or assume this becomes a calibrated confidence.
    return Answer.margin(evidence);
  },
});
```

Import `Answer` from Questions for that example. The callback is synchronous and must return a finite
number in `[0,1]`. It runs only after the entire response, usage and metadata pass validation.
Boolean confidence keeps its established meaning. The callback changes `confidenceSource` to
`custom`, never the origin of the estimated probabilities. Its errors propagate unchanged.

## Validation, deadlines and retries

The protocol uses safe internal keys (`q0`, `o0`, ...) to avoid schema/property restrictions while
retaining original application keys and values. All required keys, numeric ranges and distributions
are validated. Probability sums use the existing `1e-6` floating-point tolerance, not model-declared
rounding allowances. Missing alternatives, sums outside tolerance, extra properties, numeric strings,
non-finite values and fenced/prose responses are rejected. No clamping or renormalization occurs.

The adapter requires a completed, decision-only response with finish reason `stop`. Truncation,
refusal/content filtering, unexpected tool calls and unusable structured output fail; no partial
value reaches a schema callback, confidence gate or branch handler. A fixed system instruction keeps
context serialized as user data, but this is **not a guarantee against prompt injection** or malicious
model judgments. No tools are registered or executed, and no free-form rationale is requested.

`generateText` + `Output.object` is invoked once per evaluation. The SDK's default retry count is
explicitly overridden with **`maxRetries: 0`**. Opt in with `maxRetries: 1` (up to 10 additional attempts)
for the SDK's retryable transport failures. This policy is the SDK's, not Questions' ofetch policy.
Do not stack it with hidden retries in model middleware. Invalid structured output, confidence
rejection, Zod errors and business handlers are not retried or repaired automatically.

The total provider timeout covers prompt preparation, SDK work/retry waits and evidence projection.
Client deadlines separately cover context, hooks and Zod. Caller cancellation preserves its reason;
owned timers/listeners are disposed and late rejections observed. Neither cancellation nor retry
undoes accepted work or guarantees idempotent billing. Synchronous callbacks cannot be preempted.

Generation/output failures become `ProviderError(kind: 'response')` without retaining the raw generated
text. Invalid options/requests/metadata and custom confidence values use `ValidationError`. SDK transport
errors retain their identity and may contain sensitive request details. Sanitize application logs.
SDK warnings are returned as evidence metadata, but the SDK also has its own global warning logger;
Questions does not silently change that global or suppress another application's logging policy.

## Limits and advanced configuration

| Option            | Default                     | Contract                                                                  |
| ----------------- | --------------------------- | ------------------------------------------------------------------------- |
| `timeout`         | Unset                       | Questions duration input; entire provider evaluation                      |
| `maxRetries`      | 0                           | SDK retries; integer 0..10                                                |
| `maxOutputTokens` | 4096                        | Explicit generation token ceiling; truncation still fails                 |
| `maxQuestions`    | 128                         | Questions per evaluation, including generated presence questions          |
| `maxCriteria`     | 255                         | Alternatives/levels per question; service limits may be lower             |
| `maxPromptBytes`  | 1 MiB                       | Serialized system/user prompt and schema size before dispatch             |
| `maxOutputBytes`  | 1 MiB                       | Generated text checked **after buffering**, not an HTTP byte cap          |
| `temperature`     | Unset                       | Only passed when supplied; support/range belongs to the model             |
| `providerOptions` | Empty                       | Snapshotted provider namespaces, cloned per evaluation                    |
| `headers`         | Empty                       | Snapshotted extra headers; managed credential/protocol headers prohibited |
| `name`            | `<SDK provider>.generative` | Diagnostic label, not a prompt or model override                          |

The underlying SDK owns HTTP, authentication, pooling and response buffering. This adapter cannot
promise the ofetch transport's response-size enforcement for a model it did not construct. The SDK
may materialize reasoning or metadata beyond generated text. Limits are explicit safety checks, not a
global memory budget. Configure a bounded fetch on the provider itself when transport limits are needed.
No raw `generateText` options bag is exposed that could override the output contract or register tools.

## Streams, batches and replay

```ts
import { Streams } from "@nitoba/questions";

const tickets = ["API outage", "Invoice question"];
const results = await client.each(tickets).ask(triage); // one batched evaluation
const readable = Streams.from(tickets)
  .map((ticket, { signal }) => client.about(ticket).run(triage, { signal }), { concurrency: 2 })
  .toReadable(); // a separate evaluation per item when consumed
```

These are alternative processing strategies: executing both performs new work. Stream items contain
complete validated decisions, not partially generated JSON. Existing backpressure, cancellation,
input-order defaults and single-use source rules remain unchanged.

`prepare` captures input; `replay` performs a new potentially paid evaluation with a fresh signal
scope and operation ID. Supplying a different model explicitly sends the captured data to that
provider. Zod callbacks execute again; downstream business actions are not captured. Semantic hooks
still describe one public operation, not every SDK retry. Questions' provider HTTP hooks do not
instrument the transport of an externally constructed SDK model.

## Verification

Runtime tests exercise the real AI SDK core and official vendor SDKs with controlled responses,
covering projection, provenance, special keys, instructions, metadata, invalid output, refusals,
finish reasons, limits, cancellation, SDK backoff, snapshots, custom policies, all high-level APIs,
Zod diagnostics and replay. Packed consumers run in Node/Bun, including a native consumer with no
SDK installed. Type contracts verify all four provider factories and preserve inferred output.
No live model key or paid inference was used to establish these contracts; semantic accuracy,
provider account access and model-specific availability require separate live evaluation.

References: [AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data),
[settings](https://ai-sdk.dev/docs/ai-sdk-core/settings), and
[provider contract](https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v4).
